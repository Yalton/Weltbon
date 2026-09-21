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
import { applyManifestOps } from './apply.js';
import { remoteClientFor } from './run-sync.js';
import { type FetchLike } from './remote-client.js';
import { localIdentity } from './handshake.js';
import {
  SyncLinkNotFoundError,
  SyncUniverseAlreadyLocalError,
  SyncUniverseNotOnRemoteError,
} from './run-errors.js';
import type { ManifestRow } from './manifest.js';
import { isUniqueViolation } from '../../db/pg-error.js';

export type RemoteUniverseLocalState = 'absent' | 'present' | 'linked';

export type RemoteUniverse = ManifestRow & { localState: RemoteUniverseLocalState };

async function ownedRemote(remoteId: string, ownerId: string) {
  const [remote] = await db()
    .select()
    .from(syncRemotes)
    .where(and(eq(syncRemotes.id, remoteId), eq(syncRemotes.userId, ownerId)))
    .limit(1);
  if (!remote) throw new SyncLinkNotFoundError();
  return remote;
}

export async function listRemoteUniverses(
  remoteId: string,
  ownerId: string,
  fetchImpl?: FetchLike,
): Promise<RemoteUniverse[]> {
  const remote = await ownedRemote(remoteId, ownerId);
  const client = remoteClientFor(remote, fetchImpl);
  await client.handshake(await localIdentity());
  const rows = await client.listUniverses();
  if (rows.length === 0) return [];

  const ids = rows.map((r) => String(r.id));

  // Only the CALLER's universes (A-07): a row owned by another local user must
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

export async function adoptUniverse(opts: {
  remoteId: string;
  universeId: string;
  ownerId: string;
  fetchImpl?: FetchLike;
}): Promise<{ link: typeof syncLinks.$inferSelect; remote: typeof syncRemotes.$inferSelect }> {
  const { remoteId, universeId, ownerId } = opts;

  const remote = await ownedRemote(remoteId, ownerId);
  const client = remoteClientFor(remote, opts.fetchImpl);
  await client.handshake(await localIdentity());

  const rows = await client.listUniverses();
  const row = rows.find((u) => String(u.id) === universeId);
  if (!row) throw new SyncUniverseNotOnRemoteError();

  // A-07. Only the CALLER's own row short-circuits here: a universe owned by
  // This pre-check races the apply — NOT benignly. If the caller's OWN row for
  // it does not re-run this 409 check — so the universe upsert clobbers
  // whatever that concurrent writer just created. This is exactly what the A-07
  // calendar. It self-heals on the next LWW sync and touches only
  // universe-level settings, so this is left as-is — but it is not safe to
  const [existing] = await db()
    .select({ userId: universes.userId })
    .from(universes)
    .where(eq(universes.id, universeId))
    .limit(1);
  if (existing && existing.userId === ownerId) throw new SyncUniverseAlreadyLocalError();

  await applyManifestOps({ universe: row, ops: {} }, { universeId, ownerId });

  // The pre-check above means no link can exist yet (the FK makes a link
  try {
    const [link] = await db().insert(syncLinks).values({ universeId, remoteId }).returning();
    return { link, remote };
  } catch (e: unknown) {
    if (isUniqueViolation(e)) {
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
