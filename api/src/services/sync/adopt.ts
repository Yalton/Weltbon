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
import { SyncRemoteClient, type FetchLike } from './remote-client.js';
import { localIdentity } from './handshake.js';
import { SyncLinkNotFoundError, SyncRemoteKeyError } from './run-errors.js';
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
