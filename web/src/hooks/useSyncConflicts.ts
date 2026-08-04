/**
 * Plan F (Task 4) — TanStack Query hooks for /api/sync/conflicts/*.
 *
 * Wire shape (api/src/routes/sync-client.ts, JWT-only):
 *   GET  /sync/conflicts?universeId=   → SyncConflict[], NEWEST FIRST
 *   POST /sync/conflicts/:id/resolve   → SyncConflict   mark resolved, row untouched
 *   POST /sync/conflicts/:id/restore   → SyncConflict   write the loser back, then resolve
 *
 * WHY THIS LEDGER EXISTS. Last-write-wins compares wall clocks across two
 * instances, so skew can pick the "wrong" winner. That is only acceptable
 * because the loser is never silently discarded: the merge records it, this
 * surface shows it, and restore can bring it back. Everything below serves
 * that one guarantee.
 *
 * ONLY UNRESOLVED ROWS. The route filters to `resolvedAt IS NULL` unless
 * `?includeResolved=true`, which nothing here sends. So `data.length` IS the
 * unresolved count, and the badge needs no client-side filter that could drift
 * from the server's.
 *
 * SERVER ORDER IS THE CONTRACT. The route promises newest first and these
 * hooks return exactly what it sent. Re-deriving that order on the client would
 * silently replace the contract — and would differ again the moment two rows
 * share a `createdAt`, which D-13's idempotent batch recording makes ordinary.
 *
 * KEYS. Imported from ./syncKeys, never redeclared. A second array literal
 * computing the same key fails nothing and passes every test — right up until
 * one side is edited and `useRunSyncLink`'s post-run invalidation stops
 * matching, whose only symptom is a stale conflict list after a sync.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { syncConflictsKey } from './syncKeys';

/** One recorded LWW loss. See api/src/services/sync/conflicts.ts. */
export interface SyncConflict {
  id: string;
  universeId: string;
  /**
   * The manifest COLLECTION name — `graphPositions`, not `graph_positions`
   * (D-14) — or the literal string `universe` for the B-06 singleton. TEXT, not
   * an enum and not a table name: treat it as opaque and never switch on it
   * exhaustively.
   */
  tableName: string;
  /**
   * The row's identity WITHIN that collection, as the collection's own key
   * function produced it. Usually the row uuid, but `graphPositions` keys on
   * `entryId` and the universe singleton keys on the literal `universe`. TEXT —
   * never assume a uuid.
   */
  rowId: string;
  /**
   * `'local'` or `'remote'` today, stored as `text`. Deliberately plain
   * `string` rather than a union: the column enforces nothing, and a union
   * would promise the renderer an exhaustiveness that a third value would
   * silently break. Consumers must keep a fallback branch.
   */
  winner: string;
  /** The version that LOST — the only payload the ledger stores (see F-03). */
  loserPayload: unknown;
  /** Non-null once dismissed or restored. Always null in this hook's results. */
  resolvedAt: string | null;
  createdAt: string;
}

/**
 * List one universe's unresolved conflicts, newest first.
 *
 * `enabled` gate: `universeId` is REQUIRED by the route and validated as a
 * uuid, and the route 404s on an unknown universe. Without the gate a first
 * render would send `universeId=undefined` and paint a 400 on a surface where
 * the user has done nothing wrong.
 */
export function useSyncConflicts(universeId: string | undefined) {
  return useQuery({
    queryKey: syncConflictsKey(universeId ?? ''),
    queryFn: () =>
      api<SyncConflict[]>(`/sync/conflicts?universeId=${encodeURIComponent(universeId!)}`),
    enabled: !!universeId,
    // This list changes for exactly one reason: a sync ran. `useRunSyncLink`
    // already invalidates this key on every run (settled, not just success), so
    // the freshness that matters is event-driven and does not depend on a short
    // staleTime. Without this, the default staleTime of 0 makes every mount and
    // every window refocus refetch — a cost the badge now makes every universe
    // page visit pay, for data that provably cannot have changed.
    staleTime: 300_000,
  });
}

/**
 * The unresolved-conflict count for the sidebar badge (F-07).
 *
 * Shares `useSyncConflicts`'s query key rather than fetching again, so the
 * sidebar and the Sync tab read one cache entry and can never disagree.
 *
 * ZERO IS THE FAILURE MODE, DELIBERATELY. A badge is read as authoritative, so
 * a number that is merely plausible is worse than no number at all:
 *
 *   - loading  → 0, because no count is known yet.
 *   - error    → 0 explicitly, INCLUDING a failed refetch where TanStack keeps
 *     the previous rows in `data`. A count that survives its own query failing
 *     is a number the user cannot tell from a fresh one.
 *
 * Both suppress the badge entirely (it renders only above zero), which is
 * silence — not a confident "no conflicts here".
 */
export function useSyncConflictCount(universeId: string | undefined): number {
  const { data, error } = useSyncConflicts(universeId);
  if (error) return 0;
  return data?.length ?? 0;
}

/**
 * Dismiss a conflict: mark it resolved WITHOUT restoring the loser.
 *
 * The underlying row is not touched, so no content cache anywhere can have
 * changed and only the ledger is invalidated. Contrast `useRestoreConflict`.
 */
export function useResolveConflict(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<SyncConflict>(`/sync/conflicts/${vars.id}/resolve`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: syncConflictsKey(universeId) });
    },
  });
}

/**
 * Restore the loser: write its payload back through the apply engine (stamped
 * with a fresh `updatedAt`, so it does not lose LWW again on the next sync),
 * then mark the conflict resolved.
 *
 * WHY THE UNFILTERED SWEEP. This rewrites a REAL row, and which client caches
 * hold it is not knowable from here. `tableName` is opaque text spanning ~17
 * manifest collections plus the universe singleton, while this app's query keys
 * are per-resource literals — ['entries', uid], ['maps', uid], ['map-layers',
 * uid], ['graph-data', uid], … — with no shared prefix to sweep and no
 * mechanical relationship to a collection name.
 *
 * A hand-maintained collection→keys map is the obvious alternative and is the
 * wrong one: it would invalidate NOTHING for a collection it had not caught up
 * to, and the symptom is the worst kind — the user is told the restore
 * succeeded while looking at the version it replaced, on a feature whose entire
 * promise is that the loser is recoverable. `invalidateQueries()` with no
 * filter cannot be wrong. The cost is one refetch of the mounted queries on a
 * rare, explicitly-clicked action.
 *
 * The conflicts key is ALSO named, even though the sweep already covers it, so
 * that any future narrowing has to delete that guarantee on purpose.
 */
export function useRestoreConflict(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<SyncConflict>(`/sync/conflicts/${vars.id}/restore`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: syncConflictsKey(universeId) });
      qc.invalidateQueries();
    },
  });
}
