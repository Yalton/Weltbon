/**
 *
 * Wire shape (api/src/routes/sync-client.ts, JWT-only — a PAT cannot enumerate
 * a user's remotes):
 *   GET    /api/sync/remotes            → SyncRemote[]  (masked)
 *   POST   /api/sync/remotes            → SyncRemote    (201 new, 200 already registered)
 *   PATCH  /api/sync/remotes/:id        → SyncRemote
 *   DELETE /api/sync/remotes/:id        → 200 { deleted: true }
 *   POST   /api/sync/remotes/:id/test   → TestRemoteResult
 *
 * SCOPE. `sync_remotes` is ACCOUNT-scoped (no universe column), which is why
 * these hooks take no universe id and why their consumer lives at
 * /settings/sync rather than inside universe settings. `sync_links` and
 * `sync_conflicts` are universe-scoped and belong to the Sync tab instead.
 *
 * MASKING INVARIANT (mirrors useLlmKeys' LLMKEY-03 mirror): `SyncRemote`
 * deliberately has NO `pat` / `encryptedPat` field. The server returns only
 * `patSuffix`; the PAT travels one way, on create and on replace, and is never
 * read back. Do not add a plaintext field to this type "for convenience" — the
 * type is the client-side statement of that guarantee.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { SYNC_REMOTES_QUERY_KEY, SYNC_LINKS_QUERY_PREFIX } from './syncKeys';

export interface SyncRemote {
  id: string;
  label: string;
  baseUrl: string;
  patSuffix: string;
  createdAt: string;
}

export interface RemoteIdentity {
  weltbonVersion: string;
  appVersion: string;
  migrationHead: string;
}

export interface TestRemoteResult {
  ok: true;
  remote: RemoteIdentity;
}

export function useSyncRemotes() {
  return useQuery({
    queryKey: SYNC_REMOTES_QUERY_KEY,
    queryFn: () => api<SyncRemote[]>('/sync/remotes'),
    // mount and navigating between the two surfaces re-hits the network for a
    // invalidates, so user-initiated changes still appear immediately.
    staleTime: 60_000,
  });
}

export function useCreateSyncRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { label: string; baseUrl: string; pat: string }) =>
      api<SyncRemote>('/sync/remotes', {
        method: 'POST',
        body: JSON.stringify({ label: vars.label, baseUrl: vars.baseUrl, pat: vars.pat }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SYNC_REMOTES_QUERY_KEY });
    },
  });
}

export function useUpdateSyncRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; label?: string; baseUrl?: string; pat?: string }) => {
      const body: { label?: string; baseUrl?: string; pat?: string } = {};
      if (vars.label !== undefined) body.label = vars.label;
      if (vars.baseUrl !== undefined) body.baseUrl = vars.baseUrl;
      if (vars.pat !== undefined && vars.pat !== '') body.pat = vars.pat;
      return api<SyncRemote>(`/sync/remotes/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SYNC_REMOTES_QUERY_KEY });
    },
  });
}

export function useDeleteSyncRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<void>(`/sync/remotes/${vars.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SYNC_REMOTES_QUERY_KEY });
      // is account-scoped and holds no universe id, so it cannot name the
      qc.invalidateQueries({ queryKey: SYNC_LINKS_QUERY_PREFIX });
    },
  });
}

export function useTestSyncRemote() {
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<TestRemoteResult>(`/sync/remotes/${vars.id}/test`, { method: 'POST' }),
  });
}
