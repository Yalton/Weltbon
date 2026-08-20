/**
 * Plan F (Task 3) — TanStack Query hooks for /api/sync/links/*.
 *
 * Wire shape (api/src/routes/sync-client.ts, JWT-only):
 *   GET    /sync/links?universeId=  → SyncLink[]
 *   POST   /sync/links              → SyncLink (201)  body {universeId, remoteId}
 *   DELETE /sync/links/:id          → { deleted: true }
 *   POST   /sync/links/:id/run      → SyncRunResult   (?force=true optional)
 *
 * SCOPE. Unlike `sync_remotes` (account-scoped, useSyncRemotes.ts), `sync_links`
 * carries a `universe_id`: one row per (universe, remote) pair. Every hook here
 * therefore takes the universe id, and their consumer is the Sync tab inside
 * universe settings rather than /settings/sync. That split is decision F-01 and
 * it mirrors the data model, not a layout preference.
 *
 * KEYS. Imported from ./syncKeys, never redeclared here. A second array literal
 * computing the same key fails nothing and passes every test — right up until
 * one side is edited and `useDeleteSyncRemote`'s cascade invalidation stops
 * matching, whose only symptom is a Sync tab listing links the server already
 * deleted.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { syncLinksKey, syncConflictsKey } from './syncKeys';

/** One universe⇄remote link, with the remote's metadata joined in by the server. */
export interface SyncLink {
  id: string;
  universeId: string;
  remoteId: string;
  remoteLabel: string;
  remoteBaseUrl: string;
  /**
   * `text` on the wire, not an enum column — 'idle' | 'syncing' | 'error' are
   * the values the server writes today. Deliberately plain `string`: no caller
   * reads it (the row's meaning reaches the UI through `lastSyncedAt` and
   * `lastError` instead), so a union would promise an exhaustiveness the
   * column does not enforce and that nothing would benefit from.
   */
  status: string;
  lastSyncedAt: string | null;
  /**
   * `safeErrorSummary`'s scrubbed one-liner from the last failed run. Render it
   * ONLY through `lastErrorMessage` (lib/syncErrorCopy.ts) — for
   * `blob-unavailable` this column is the only place the client ever learns
   * WHICH instance is missing the bytes, because `side` is not on the wire.
   */
  lastError: string | null;
  createdAt: string;
}

/** Per-collection row counts from one direction of a run. */
export interface SyncRunCounts {
  upserted: Record<string, number>;
  deleted: Record<string, number>;
}

/** `POST /sync/links/:id/run` — 200 only; every failure throws an ApiError. */
export interface SyncRunResult {
  linkId: string;
  bootstrapped: boolean;
  conflicts: number;
  blobsPushed: number;
  blobsPulled: number;
  /**
   * Plan E: byte-less LOCAL asset rows this run restored. It counts PLANNED
   * restores and is known to undercount, so it must never be rendered as an
   * exact figure — see components/SyncTab.tsx.
   */
  assetsRepairedLocally: number;
  assetsRepairedOnPeer: number;
  assetsSweptOnPeer: number;
  /** Plan E (E-03): rows whose bytes neither side holds — a warning, not a failure. */
  assetsUnrepairable: number;
  pushed: SyncRunCounts;
  appliedLocally: SyncRunCounts;
}

/**
 * List one universe's sync links.
 *
 * `enabled` gate: the caller gets its id from `useParams`, which is typed
 * `string | undefined`, and the server validates `universeId: z.string().uuid()`.
 * Without the gate a first render would send `universeId=undefined` and paint a
 * 400 on a tab where the user has done nothing wrong.
 */
export function useSyncLinks(universeId: string | undefined) {
  return useQuery({
    queryKey: syncLinksKey(universeId ?? ''),
    queryFn: () => api<SyncLink[]>(`/sync/links?universeId=${encodeURIComponent(universeId!)}`),
    enabled: !!universeId,
  });
}

/** Link this universe to an already-registered remote. 409 if the pair exists. */
export function useCreateSyncLink(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { remoteId: string }) =>
      api<SyncLink>('/sync/links', {
        method: 'POST',
        body: JSON.stringify({ universeId, remoteId: vars.remoteId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: syncLinksKey(universeId) });
      // SYNC_REMOTES_QUERY_KEY is deliberately untouched: a link is a new row
      // in a different, universe-scoped table. The remote it points at is
      // unchanged, and refetching the account-scoped list would be noise.
    },
  });
}

/** Remove a link. The server also drops the link's stored base snapshot. */
export function useDeleteSyncLink(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<{ deleted: true }>(`/sync/links/${vars.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: syncLinksKey(universeId) });
      // Conflicts survive the link that produced them — `sync_conflicts` is
      // keyed on universe_id alone and nothing cascades from this DELETE — so
      // invalidating that key here would refetch rows that cannot have changed.
    },
  });
}

/**
 * Run the drive loop for one link (F-02: the caller awaits this and renders
 * either the result summary or the mapped error — no fire-and-forget).
 *
 * `force` maps to `?force=true`, which ignores THIS link's own stuck lease. It
 * is the recovery path for a claim left behind by a closed tab, since the
 * server lease is 30 minutes.
 */
export function useRunSyncLink(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; force?: boolean }) =>
      api<SyncRunResult>(`/sync/links/${vars.id}/run${vars.force ? '?force=true' : ''}`, {
        method: 'POST',
      }),
    // onSettled, NOT onSuccess — and the difference is load-bearing.
    //
    // `blob-unavailable`'s `side` (WHICH instance is missing the bytes) is not
    // on the wire: the route serializes only {error, code}. The server writes
    // that remedy into `sync_links.last_error` BEFORE the route returns its
    // error, so a refetch of the link row is the ONLY path by which it reaches
    // the client. Invalidating on success alone leaves the cached row carrying
    // the previous last_error and the user is never told which side to fix.
    //
    // A failed run can also have advanced conflicts before it threw (the merge
    // records them, then the push fails), so conflicts are refetched too.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: syncLinksKey(universeId) });
      qc.invalidateQueries({ queryKey: syncConflictsKey(universeId) });
      // A run can apply any of the synced collections, and those content
      // queries have no shared universe-scoped key prefix. It may also commit
      // the local apply before a later step fails. Sweep on both outcomes so
      // the UI never keeps showing the pre-sync empty/stale universe.
      qc.invalidateQueries();
    },
  });
}
