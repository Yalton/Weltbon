/**
 * useShares — react-query hooks for the Phase 29 owner-facing share-link
 * CRUD surface (Plan 02 — `/api/shares`).
 *
 * Mirrors the `useInvites` convention exactly: a single `['shares']` queryKey
 * for the list; every mutation invalidates it on success. The list endpoint
 * returns `{ shares: ShareLink[] }` (see api/src/routes/shares.ts L301-340);
 * the hook unwraps `.shares` so consumers get the array directly.
 *
 * Per-token shape carries no plaintext / shareUrl — those are stripped on
 * the server (T-29-09). The mint response (POST /shares) is the ONLY place
 * `shareUrl` surfaces, and `CreateShareLinkDialog` holds it in component
 * state until the dialog closes (T-29-31 one-time reveal).
 *
 * Routes consumed (Plan 02):
 *   GET    /api/shares           → { shares: ShareLink[] }
 *   POST   /api/shares           → ShareLinkWithUrl (shareUrl returned once)
 *   PATCH  /api/shares/:id       → { id, label }
 *   DELETE /api/shares/:id       → 204 No Content
 *
 * All four are JWT-only (D-13 mirror) — PAT bearers are rejected so a stolen
 * PAT cannot mint or revoke share links.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * A share-link row as returned by GET /api/shares.
 *
 * `bodySuffix` is the last 4 chars of the plaintext body portion, surfaced
 * only so the UI can render a masked preview (`wbn_share_••••••ABCD`).
 * `lastAccessedAt` + `accessCount` + `revokedAt` populate the audit columns
 * on /settings/shares (UI-SPEC §F).
 */
export interface ShareLink {
  id: string;
  universeId: string;
  universeName: string;
  label: string;
  bodySuffix: string;
  scope: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
}

/**
 * The full response from POST /api/shares.
 *
 * `shareUrl` carries the absolute URL with the plaintext token embedded —
 * shown exactly once in the reveal phase of CreateShareLinkDialog and
 * cleared from React state on dialog close (T-29-31 one-time reveal).
 * Server-side persistence is hash-only (Plan 01 schema).
 */
export interface ShareLinkWithUrl {
  id: string;
  label: string;
  bodySuffix: string;
  expiresAt: string | null;
  createdAt: string;
  shareUrl: string;
}

/**
 * The expiry-window dropdown choices (UI-SPEC §E + Plan 02 createSchema).
 * `null` maps to "No expiry"; numeric values map to `now() + N days` server-side.
 */
export type ShareExpiryDays = 7 | 30 | 90 | 180 | 365 | null;

/**
 * TanStack Query hook for the current owner's share-link list (every universe).
 *
 * Keyed on `['shares']` — invalidated by every mutation hook below. No
 * `enabled` gate: the consumer pages render behind ProtectedRoute. The
 * server returns `{ shares: [...] }`; this hook unwraps so the caller
 * receives the array directly.
 */
export function useShares() {
  return useQuery({
    queryKey: ['shares'],
    queryFn: () =>
      api<{ shares: ShareLink[] }>('/shares').then((r) => r.shares),
  });
}

/**
 * Mutation: mint a new share-link token.
 *
 * On success, invalidates `['shares']` so the table reflects the new row.
 * Returns the full `ShareLinkWithUrl` so the caller can display `shareUrl`
 * exactly once in the reveal phase (T-29-31 one-time reveal).
 */
export function useCreateShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      universeId: string;
      label: string;
      expiresInDays: ShareExpiryDays;
    }) =>
      api<ShareLinkWithUrl>('/shares', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares'] });
    },
  });
}

/**
 * Mutation: rename a share link by id (PATCH /api/shares/:id).
 *
 * On success, invalidates `['shares']` so the row reflects the new label.
 * The server enforces revocation guard (T-29-11): revoked tokens are
 * unrenameable and return 404.
 */
export function useRenameShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      api<{ id: string; label: string }>(`/shares/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares'] });
    },
  });
}

/**
 * Mutation: soft-revoke a share-link by id (DELETE /api/shares/:id).
 *
 * On success AND on error, invalidates `['shares']` — a 404 race (revoked
 * in another tab) is reconciled by the refetch rather than surfacing a
 * spurious error (mirrors useRevokeInvite silent-recovery pattern).
 * Soft-revoke preserves last_accessed_at + access_count + label in the DB
 * for the owner audit trail (D-06).
 */
export function useRevokeShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/shares/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares'] });
    },
    onError: () => {
      // Silently invalidate on 404 race — the row will resolve on refetch.
      qc.invalidateQueries({ queryKey: ['shares'] });
    },
  });
}
