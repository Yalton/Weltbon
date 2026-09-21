
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { syncConflictsKey } from './syncKeys';

export interface SyncConflict {
  id: string;
  universeId: string;
  tableName: string;
  rowId: string;
  winner: string;
  loserPayload: unknown;
  resolvedAt: string | null;
  createdAt: string;
}

export function useSyncConflicts(universeId: string | undefined) {
  return useQuery({
    queryKey: syncConflictsKey(universeId ?? ''),
    queryFn: () =>
      api<SyncConflict[]>(`/sync/conflicts?universeId=${encodeURIComponent(universeId!)}`),
    enabled: !!universeId,
    staleTime: 300_000,
  });
}

export function useSyncConflictCount(universeId: string | undefined): number {
  const { data, error } = useSyncConflicts(universeId);
  if (error) return 0;
  return data?.length ?? 0;
}

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
