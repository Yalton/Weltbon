import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * A personal access token row as returned by GET /api/auth/tokens.
 * The hash and plaintext are never included in list responses (server-side whitelist).
 */
export interface Token {
  id: string;
  label: string;
  bodySuffix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * The full response from POST /api/auth/tokens.
 * plaintext is shown exactly once (API-01); it is not stored after the modal closes.
 */
export interface TokenWithPlaintext extends Token {
  plaintext: string;
}

/**
 * TanStack Query hook for the current user's PAT list.
 *
 * Keyed on ['tokens'] — invalidated by useCreateToken and useRevokeToken.
 * No `enabled` gate: the page renders behind ProtectedRoute.
 */
export function useTokens() {
  return useQuery({
    queryKey: ['tokens'],
    queryFn: () => api<Token[]>('/auth/tokens'),
  });
}

/**
 * Mutation: mint a new personal access token.
 *
 * On success, invalidates ['tokens'] so the table reflects the new row.
 * Returns the full TokenWithPlaintext so the caller can display plaintext once.
 */
export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label }: { label: string }) =>
      api<TokenWithPlaintext>('/auth/tokens', {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
}

/**
 * Mutation: revoke (hard-delete) a personal access token by id.
 *
 * On success AND on error, invalidates ['tokens'].
 * A 404 error means the token was already gone (race between tabs or already revoked);
 * silently invalidating reflects truth in the UI without surfacing a spurious error
 * (UI-SPEC §9.5 default §12.3, T-09-15 mitigation).
 */
export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/auth/tokens/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
    onError: () => {
      // Silently invalidate on error (e.g. 404 race) — the row will disappear on refresh.
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
}
