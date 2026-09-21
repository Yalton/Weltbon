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

export function useTokens() {
  return useQuery({
    queryKey: ['tokens'],
    queryFn: () => api<Token[]>('/auth/tokens'),
  });
}

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
      qc.invalidateQueries({ queryKey: ['tokens'] });
    },
  });
}
