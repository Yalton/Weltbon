/**
 * Universe adoption (spec 2026-08-08, A-01..A-12) — acquiring a universe this
 * instance does not yet hold.
 *
 * A-01: adoption creates the LOCAL universe first and then an ordinary link,
 * rather than letting a link bootstrap its own universe. That keeps the
 * invariant every other part of sync already relies on — a sync_links row's
 * universe exists, and its owner IS the link's owner — enforced by the existing
 * foreign key instead of a new owner column. Nothing in run-sync.ts,
 * routes/sync-client.ts or services/sync/conflicts.ts changes as a result.
 *
 * A-04b: every peer-dialing function here takes an optional `fetchImpl`, with
 * the route as a thin wrapper. That is not stylistic — D-05's injectable
 * transport is the only way the two-instance suites drive a real peer
 * in-process, so a peer call reachable only through a route could not be tested
 * against a real peer at all.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncLinks, syncRemotes, universes } from '../../db/schema.js';
import { env } from '../../config.js';
import { decryptSecret } from '../crypto.js';
import { applyManifestOps } from './apply.js';
import { SyncRemoteClient, type FetchLike } from './remote-client.js';
import { localIdentity } from './handshake.js';
import {
  SyncLinkNotFoundError,
  SyncRemoteKeyError,
  SyncUniverseAlreadyLocalError,
  SyncUniverseNotOnRemoteError,
} from './run-errors.js';
import type { ManifestRow } from './manifest.js';

/**
 * What this instance can do with a universe the remote holds (A-07).
 *
 *  - `absent`  — we do not have it: offer Adopt.
 *  - `present` — the CALLER holds it but it is not linked to this remote: offer
 *                the ordinary link route, which merges two existing universes.
 *  - `linked`  — already paired with this remote: nothing to offer.
 *
 * A universe held by a DIFFERENT user on this instance reads `absent`, not
 * `present`: this field answers "what can this caller do", and reporting a
 * stranger's row would both mislead the caller and disclose that the id is
 * taken. Adopt then refuses it with the apply engine's own 403 (A-07).
 */
export type RemoteUniverseLocalState = 'absent' | 'present' | 'linked';

export type RemoteUniverse = ManifestRow & { localState: RemoteUniverseLocalState };

/** The caller's own remote row, or the same 404-shaped error testRemote uses. */
async function ownedRemote(remoteId: string, ownerId: string) {
  const [remote] = await db()
    .select()
    .from(syncRemotes)
    .where(and(eq(syncRemotes.id, remoteId), eq(syncRemotes.userId, ownerId)))
    .limit(1);
  if (!remote) throw new SyncLinkNotFoundError();
  return remote;
}

/** A connected client for `remote`, or a typed key error. Mirrors testRemote. */
function clientFor(remote: typeof syncRemotes.$inferSelect, fetchImpl?: FetchLike): SyncRemoteClient {
  const cfg = env();
  if (!cfg.llmKeyEncryptionKey) throw new SyncRemoteKeyError('encryption key not configured');
  const pat = decryptSecret(remote.encryptedPat, cfg.llmKeyEncryptionKey);
  if (pat === null) throw new SyncRemoteKeyError('could not decrypt stored PAT');
  return new SyncRemoteClient({ baseUrl: remote.baseUrl, pat, fetchImpl });
}

/**
 * The universes `remoteId` holds for its stored PAT's owner, each annotated
 * with what this instance can do with it (A-07).
 *
 * The annotation is computed HERE rather than in the browser: this runs on the
 * user's own instance and resolves all three states with two local queries,
 * where a client would need the local universe list plus one links query per
 * universe.
 */
export async function listRemoteUniverses(
  remoteId: string,
  ownerId: string,
  fetchImpl?: FetchLike,
): Promise<RemoteUniverse[]> {
  const remote = await ownedRemote(remoteId, ownerId);
  const client = clientFor(remote, fetchImpl);
  await client.handshake(await localIdentity());
  const rows = await client.listUniverses();
  if (rows.length === 0) return [];

  const ids = rows.map((r) => String(r.id));

  // Only the CALLER's universes (A-07): a row owned by another local user must
  // not read `present`.
  const mine = await db()
    .select({ id: universes.id })
    .from(universes)
    .where(and(inArray(universes.id, ids), eq(universes.userId, ownerId)));
  const held = new Set(mine.map((u) => u.id));

  const linkedRows = await db()
    .select({ universeId: syncLinks.universeId })
    .from(syncLinks)
    .where(and(inArray(syncLinks.universeId, ids), eq(syncLinks.remoteId, remoteId)));
  const linked = new Set(linkedRows.map((l) => l.universeId));

  return rows.map((row) => {
    const id = String(row.id);
    const localState: RemoteUniverseLocalState = linked.has(id)
      ? 'linked'
      : held.has(id)
        ? 'present'
        : 'absent';
    return { ...row, localState };
  });
}

/**
 * Adopt `universeId` from `remoteId`: create the local universe from the
 * remote's own row, then an ordinary link.
 *
 * A-02: the universe is created by `applyManifestOps({universe, ops: {}})` —
 * the engine's own C-11 create path, the exact call run-sync.ts:262 makes in
 * the OPPOSITE direction to seed a universe onto a peer (F0-01). Reusing it
 * rather than hand-writing an INSERT is what makes the adopted row identical to
 * the remote's: UNIVERSE_APPLY.toValues copies every field and both timestamps
 * verbatim and takes userId from ctx.ownerId (C-08). Because updatedAt matches,
 * the first merge sees no universe difference and records no phantom conflict.
 * A hand-written insert would stamp `now()` and immediately push a
 * content-identical row back over the remote with a newer timestamp.
 *
 * A-09: the seed and the link insert are deliberately NOT one transaction —
 * applyManifestOps owns its own (it takes the C-16 advisory lock inside), and
 * nesting would mean threading a tx through the engine's public entry point.
 * If the insert fails after the seed, the caller holds an empty universe they
 * own and no link. That is recoverable, not corrupt: re-running adopt takes the
 * A-07 409 path, and the remedy it names — the ordinary link route — now
 * succeeds, because the universe exists.
 *
 * The row is read from the peer on THIS call, never taken from the caller:
 * it feeds a write.
 */
export async function adoptUniverse(opts: {
  remoteId: string;
  universeId: string;
  ownerId: string;
  fetchImpl?: FetchLike;
}): Promise<{ link: typeof syncLinks.$inferSelect; remote: typeof syncRemotes.$inferSelect }> {
  const { remoteId, universeId, ownerId } = opts;

  const remote = await ownedRemote(remoteId, ownerId);
  const client = clientFor(remote, opts.fetchImpl);
  await client.handshake(await localIdentity());

  const rows = await client.listUniverses();
  const row = rows.find((u) => String(u.id) === universeId);
  if (!row) throw new SyncUniverseNotOnRemoteError();

  // A-07. Only the CALLER's own row short-circuits here: a universe owned by
  // another local user falls through to applyManifestOps, whose ownership check
  // raises UniverseOwnershipError → 403. Answering 409 for a stranger's row
  // would both misdescribe the remedy (linking it is not possible either) and
  // disclose that the id is taken.
  //
  // This pre-check races the apply — NOT benignly. If the caller's OWN row for
  // this id is created between this SELECT and the apply below, the ownership
  // check inside applyManifestOps sees a row owned by ctx.ownerId and PASSES —
  // it does not re-run this 409 check — so the universe upsert clobbers
  // whatever that concurrent writer just created. This is exactly what the A-07
  // mutation test demonstrates when the check is removed entirely; the window
  // here is the same defect narrowed to a race instead of guaranteed.
  //
  // Two ways into that window, not one. The rare one needs the SAME uuid
  // created independently by a concurrent peer push. The one that does NOT
  // need any coincidence: two concurrent adopts of the SAME universe id from
  // two different remotes — prod plus a second device, the feature's own
  // motivating setup. Both see `absent` here, both apply, and the second
  // clobbers the first's universe row with a possibly older name/theme/
  // calendar. It self-heals on the next LWW sync and touches only
  // universe-level settings, so this is left as-is — but it is not safe to
  // assume away, and do not widen it further believing the apply's own check
  // covers it, because that check only covers a DIFFERENT owner.
  const [existing] = await db()
    .select({ userId: universes.userId })
    .from(universes)
    .where(eq(universes.id, universeId))
    .limit(1);
  if (existing && existing.userId === ownerId) throw new SyncUniverseAlreadyLocalError();

  await applyManifestOps({ universe: row, ops: {} }, { universeId, ownerId });

  // The pre-check above means no link can exist yet (the FK makes a link
  // without its universe unrepresentable), so this guard covers only two
  // concurrent adopts — the same 23505 shape postLinkRoute already uses.
  try {
    const [link] = await db().insert(syncLinks).values({ universeId, remoteId }).returning();
    return { link, remote };
  } catch (e: unknown) {
    // Drizzle wraps the PG error: the '23505' code may be on the top-level
    // error (e.code) or on the cause (e.cause.code) depending on the Drizzle
    // version. Check both to be safe — same idiom as templates.ts, llm-keys.ts,
    // dictionary.ts and audits.ts. A bare `err?.code` (what this used to read)
    // never matches: Drizzle 0.45 rethrows driver errors as DrizzleQueryError,
    // which carries no `.code` of its own.
    const err = e as { code?: string; cause?: { code?: string } } | null;
    const code = err?.code ?? err?.cause?.code;
    if (code === '23505') {
      const [link] = await db()
        .select()
        .from(syncLinks)
        .where(and(eq(syncLinks.universeId, universeId), eq(syncLinks.remoteId, remoteId)))
        .limit(1);
      if (link) return { link, remote };
    }
    throw e;
  }
}
