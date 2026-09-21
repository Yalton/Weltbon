
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { syncLinksKey, syncConflictsKey } from './syncKeys';

export interface SyncLink {
  id: string;
  universeId: string;
  remoteId: string;
  remoteLabel: string;
  remoteBaseUrl: string;
  status: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  autoSync: boolean;
  pausedReason: string | null;
  nextPollAt: string | null;
  failureCount: number;
}

export interface SyncRunCounts {
  upserted: Record<string, number>;
  deleted: Record<string, number>;
}

export interface SyncRunResult {
  linkId: string;
  bootstrapped: boolean;
  conflicts: number;
  blobsPushed: number;
  blobsPulled: number;
  assetsRepairedLocally: number;
  assetsRepairedOnPeer: number;
  assetsSweptOnPeer: number;
  assetsUnrepairable: number;
  pushed: SyncRunCounts;
  appliedLocally: SyncRunCounts;
}

export function useSyncLinks(
  universeId: string | undefined,
  options: { refetchInterval?: number } = {},
) {
  return useQuery({
    queryKey: syncLinksKey(universeId ?? ''),
    queryFn: () => api<SyncLink[]>(`/sync/links?universeId=${encodeURIComponent(universeId!)}`),
    enabled: !!universeId,
    refetchInterval: options.refetchInterval,
  });
}

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
      // in a different, universe-scoped table. The remote it points at is
      // unchanged, and refetching the account-scoped list would be noise.
    },
  });
}

export function useDeleteSyncLink(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<{ deleted: true }>(`/sync/links/${vars.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: syncLinksKey(universeId) });
    },
  });
}

export function useSetLinkAutoSync(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { linkId: string; autoSync: boolean }) =>
      api<SyncLink>(`/sync/links/${vars.linkId}`, {
        method: 'PATCH',
        body: JSON.stringify({ autoSync: vars.autoSync }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: syncLinksKey(universeId) });
    },
  });
}

export function useRunSyncLink(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; force?: boolean }) =>
      api<SyncRunResult>(`/sync/links/${vars.id}/run${vars.force ? '?force=true' : ''}`, {
        method: 'POST',
      }),
    // onSettled, NOT onSuccess — and the difference is load-bearing.
    // `blob-unavailable`'s `side` (WHICH instance is missing the bytes) is not
    onSettled: () => {
      qc.invalidateQueries({ queryKey: syncLinksKey(universeId) });
      qc.invalidateQueries({ queryKey: syncConflictsKey(universeId) });
      // queries have no shared universe-scoped key prefix. It may also commit
      // the UI never keeps showing the pre-sync empty/stale universe.
      qc.invalidateQueries();
    },
  });
}
