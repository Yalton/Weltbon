/**
 *
 * Wire shape (api/src/routes/llm-connections.ts, JWT-only via requireJwtAuth
 * — mirrors llm-keys.ts's mutation routes, which also exclude PATs because a
 * decrypted secret flows through the handler):
 *   GET    /api/llm-connections/:provider          → LlmConnection
 *   PUT    /api/llm-connections/:provider          → LlmConnection (upsert)
 *   DELETE /api/llm-connections/:provider          → 204
 *   POST   /api/llm-connections/:provider/test     → { lastValidatedAt }
 *   GET    /api/llm-connections/:provider/models   → OllamaModelInfo[]
 *
 * Desktop-only, enforced server-side (twice — see llm-connections.ts file
 * header). Every hook here still works if called on a hosted instance; the
 * server 403s and the query/mutation surfaces that as its error the normal
 * TanStack way. `OllamaConnectionSection` never calls these off a hosted
 * instance in practice (it renders nothing there — see its own file), so
 * this is defence-in-depth, not a path any real user hits.
 *
 * Follows useSyncRemotes.ts's shape: a useQuery per read, a useMutation per
 * write that invalidates its query key on success.
 *
 * MASKING INVARIANT (mirrors useLlmKeys / useSyncRemotes): `LlmConnection`
 * carries `secretSuffix`, never a plaintext secret. `baseUrl` is NOT a
 * secret (llm-connections.ts file header) and is always returned in clear —
 * do not treat it as sensitive client-side either.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export type ConnectionProvider = 'ollama';

export interface LlmConnection {
  provider: ConnectionProvider;
  baseUrl: string;
  label: string;
  /** Last 4 chars of the stored secret, or null when no secret is stored. */
  bodySuffix: string | null;
  createdAt: string;
  lastValidatedAt: string | null;
}

export interface OllamaModelInfo {
  name: string;
  supportsTools: boolean;
  contextLength: number | null;
}

function connectionKey(provider: ConnectionProvider) {
  return ['llm-connection', provider] as const;
}

function modelsKey(provider: ConnectionProvider) {
  return ['llm-connection-models', provider] as const;
}

export function useLlmConnection(provider: ConnectionProvider, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: connectionKey(provider),
    queryFn: () => api<LlmConnection>(`/llm-connections/${provider}`),
    enabled: options?.enabled ?? true,
    retry: false,
  });
}

export function useSaveLlmConnection(provider: ConnectionProvider) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { baseUrl: string; label?: string; secret?: string }) =>
      api<LlmConnection>(`/llm-connections/${provider}`, {
        method: 'PUT',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionKey(provider) });
      qc.invalidateQueries({ queryKey: modelsKey(provider) });
    },
  });
}

export function useDeleteLlmConnection(provider: ConnectionProvider) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/llm-connections/${provider}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionKey(provider) });
      qc.invalidateQueries({ queryKey: modelsKey(provider) });
    },
  });
}

export function useTestLlmConnection(provider: ConnectionProvider) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ lastValidatedAt: string }>(`/llm-connections/${provider}/test`, {
      method: 'POST',
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionKey(provider) });
    },
  });
}

export function useOllamaModels(provider: ConnectionProvider, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: modelsKey(provider),
    queryFn: () => api<OllamaModelInfo[]>(`/llm-connections/${provider}/models`),
    enabled: options?.enabled ?? true,
    retry: false,
  });
}
