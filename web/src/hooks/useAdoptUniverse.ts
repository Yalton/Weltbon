/**
 * Universe adoption (spec 2026-08-08) — hooks for the two routes that let a
 * user acquire a universe this instance does not hold.
 *
 *   GET  /api/sync/remotes/:id/universes  → { universes: RemoteUniverse[] }
 *   POST /api/sync/adopt                  → SyncLink (201)
 *
 * SCOPE. These live apart from useSyncLinks.ts because that module is
 * universe-scoped (F-01) and adoption by definition has no local universe yet.
 * They sit with the remote instead, which is where the Sync settings page
 * offers them (A-12).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { remoteUniversesKey, SYNC_LINKS_QUERY_PREFIX } from './syncKeys';
import type { SyncLink } from './useSyncLinks';

/**
 * A universe the remote holds, and what this instance can do with it.
 *
 * `localState` is computed by the SERVER (A-07): `absent` → adopt, `present` →
 * link the copy we already have, `linked` → nothing to do. A universe held by a
 * different user on this instance reads `absent`; adopting it then fails with a
 * 403, which is the correct and non-disclosing outcome.
 */
export interface RemoteUniverse {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  localState: 'absent' | 'present' | 'linked';
}

/**
 * What one remote holds. Every call dials the peer through our server, so this
 * is deliberately NOT given a staleTime — a cached list would offer Adopt for a
 * universe that has since been deleted there.
 */
export function useRemoteUniverses(remoteId: string | undefined) {
  return useQuery({
    queryKey: remoteUniversesKey(remoteId ?? ''),
    queryFn: async () => {
      const body = await api<{ universes: RemoteUniverse[] }>(
        `/sync/remotes/${encodeURIComponent(remoteId!)}/universes`,
      );
      return body.universes;
    },
    enabled: !!remoteId,
  });
}

/** Every key an adoption or a link changes. Shared so the two cannot drift. */
function invalidateAfterLinking(qc: ReturnType<typeof useQueryClient>, remoteId: string) {
  // The row's localState changed, so the browse list must refetch.
  qc.invalidateQueries({ queryKey: remoteUniversesKey(remoteId) });
  // A link now exists for a universe whose Sync tab may be mounted. The PREFIX,
  // because this surface is account-scoped and does not know which universes
  // have a cached list.
  qc.invalidateQueries({ queryKey: SYNC_LINKS_QUERY_PREFIX });
  // The adopted universe must appear in the app's universe list. Nothing else
  // invalidates ['universes'] on this path — the user did not create it through
  // useCreateUniverse — so omitting this leaves them staring at a list that
  // does not contain the thing they just adopted.
  qc.invalidateQueries({ queryKey: ['universes'] });
}

/**
 * Adopt a universe from a remote: creates the local universe and the link.
 *
 * A-06: this does NOT sync. The caller runs `useRunSyncLink` next and renders
 * the ordinary run summary, so adoption reuses F-02's blocking run and F-06's
 * "a first sync can take several minutes with images" copy rather than
 * inventing a second long-running request.
 */
export function useAdoptUniverse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { remoteId: string; universeId: string }) =>
      api<SyncLink>('/sync/adopt', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_data, vars) => invalidateAfterLinking(qc, vars.remoteId),
  });
}

/**
 * Link a universe this instance ALREADY holds to the remote — the `present`
 * branch of A-07.
 *
 * Deliberately separate from useSyncLinks' `useCreateSyncLink`, which is built
 * per-universe and invalidates exactly one universe's key. This surface is
 * account-scoped and does not know which universe lists are cached, so it needs
 * the prefix invalidation above. Same endpoint, different blast radius.
 */
export function useLinkRemoteUniverse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { remoteId: string; universeId: string }) =>
      api<SyncLink>('/sync/links', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_data, vars) => invalidateAfterLinking(qc, vars.remoteId),
  });
}
