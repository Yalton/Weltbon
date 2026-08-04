/**
 * Plan F (Task 2) — TanStack Query hooks for /api/sync/remotes/*.
 *
 * Wire shape (api/src/routes/sync-client.ts, JWT-only — a PAT cannot enumerate
 * a user's remotes):
 *   GET    /api/sync/remotes            → SyncRemote[]  (masked)
 *   POST   /api/sync/remotes            → SyncRemote    (201)
 *   PATCH  /api/sync/remotes/:id        → SyncRemote
 *   DELETE /api/sync/remotes/:id        → 204 (void)
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

/** A saved remote connection, as the server masks it. Never carries the PAT. */
export interface SyncRemote {
  id: string;
  label: string;
  baseUrl: string;
  /** Last few characters of the stored token — the only part ever returned. */
  patSuffix: string;
  createdAt: string;
}

/** The peer instance's self-report, from the S-08 handshake. */
export interface RemoteIdentity {
  weltbonVersion: string;
  appVersion: string;
  migrationHead: string;
}

/** `POST /sync/remotes/:id/test` — 200 only; every failure throws an ApiError. */
export interface TestRemoteResult {
  ok: true;
  remote: RemoteIdentity;
}

export const SYNC_REMOTES_QUERY_KEY = ['sync', 'remotes'] as const;

/**
 * PREFIX, not a full key: universe-scoped link queries key on
 * `['sync', 'links', universeId]`. Invalidating the two-element prefix matches
 * every universe's links at once — see `useDeleteSyncRemote` for why that
 * breadth is required rather than merely convenient.
 */
export const SYNC_LINKS_QUERY_PREFIX = ['sync', 'links'] as const;

/**
 * The full key for ONE universe's sync links — the other half of the contract
 * `SYNC_LINKS_QUERY_PREFIX` only half-states.
 *
 * Task 3's link hooks must build their query key with this factory rather than
 * writing an array literal. Nothing about a prefix constant stops a consumer
 * from keying links as, say, `['sync-links', universeId]`, at which point the
 * invalidation in `useDeleteSyncRemote` below silently stops matching and the
 * only symptom is a Sync tab listing links the server already cascaded away.
 * A shared factory makes that drift a compile error instead of a ghost.
 */
export const syncLinksKey = (universeId: string) =>
  [...SYNC_LINKS_QUERY_PREFIX, universeId] as const;

/** List the caller's registered remotes (masked). */
export function useSyncRemotes() {
  return useQuery({
    queryKey: SYNC_REMOTES_QUERY_KEY,
    queryFn: () => api<SyncRemote[]>('/sync/remotes'),
  });
}

/** Register a new remote. `pat` is minted on the OTHER instance (F-05). */
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

/**
 * Update a remote's label, base URL, and/or stored PAT.
 *
 * The body is assembled key-by-key rather than spread, because the server
 * validates `pat: z.string().min(1).optional()`: a body that carries `pat` at
 * all must carry a non-empty one. An edit form whose token field was left
 * blank means "keep the current token", so `pat` must be ABSENT from the JSON,
 * not present-and-empty. (`undefined` would also vanish through
 * JSON.stringify, but only by accident of the serializer; omitting the key is
 * the explicit statement.)
 */
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

/** Delete a remote. See the invalidation comment — the blast radius is wide. */
export function useDeleteSyncRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<void>(`/sync/remotes/${vars.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SYNC_REMOTES_QUERY_KEY });
      // `sync_links.remote_id` is `onDelete: 'cascade'`
      // (api/src/db/schema.ts:775), so this DELETE also destroyed every
      // sync link that pointed at this remote — in EVERY universe that used
      // it, not just whichever universe the user last had open. This module
      // is account-scoped and holds no universe id, so it cannot name the
      // affected keys; invalidating the whole `['sync','links']` prefix is
      // the only way to stop a Sync tab from rendering links the server has
      // already deleted.
      qc.invalidateQueries({ queryKey: SYNC_LINKS_QUERY_PREFIX });
    },
  });
}

/**
 * Run the S-08 handshake against a saved remote.
 *
 * Deliberately does NOT invalidate anything: a handshake reads the peer's
 * identity and touches no local row, so a refetch would be pure noise. The
 * result is transient per-row UI state for the caller to render.
 */
export function useTestSyncRemote() {
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<TestRemoteResult>(`/sync/remotes/${vars.id}/test`, { method: 'POST' }),
  });
}
