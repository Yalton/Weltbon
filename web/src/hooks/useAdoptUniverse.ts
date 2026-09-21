import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { remoteUniversesKey, SYNC_LINKS_QUERY_PREFIX } from './syncKeys';
import type { SyncLink } from './useSyncLinks';

export interface RemoteUniverse {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  localState: 'absent' | 'present' | 'linked';
}

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

export function invalidateAfterLinking(qc: ReturnType<typeof useQueryClient>, remoteId: string) {
  qc.invalidateQueries({ queryKey: remoteUniversesKey(remoteId) });
  // because this surface is account-scoped and does not know which universes
  qc.invalidateQueries({ queryKey: SYNC_LINKS_QUERY_PREFIX });
  qc.invalidateQueries({ queryKey: ['universes'] });
}

export function useAdoptUniverse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { remoteId: string; universeId: string }) =>
      api<SyncLink>('/sync/adopt', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_data, vars) => invalidateAfterLinking(qc, vars.remoteId),
  });
}

export function useLinkRemoteUniverse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { remoteId: string; universeId: string }) =>
      api<SyncLink>('/sync/links', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_data, vars) => invalidateAfterLinking(qc, vars.remoteId),
  });
}
