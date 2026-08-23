/**
 * Issue #48 Task 7 — TanStack Query hooks for /api/llm-connections/*
 * (Task 6's endpoint-based provider CRUD; Ollama is the only member today).
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

/** The one endpoint-based provider today. Widen alongside CONNECTION_PROVIDER_NAMES
 *  in api/src/routes/llm-connections.ts if a second one ever ships. */
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
  /** The model's architectural maximum context — see api/src/providers/llm/ollama.ts. */
  contextLength: number | null;
}

function connectionKey(provider: ConnectionProvider) {
  return ['llm-connection', provider] as const;
}

function modelsKey(provider: ConnectionProvider) {
  return ['llm-connection-models', provider] as const;
}

/**
 * Read the caller's stored connection for a provider.
 *
 * 404 (no row yet) surfaces as a query `error`, not a special "empty" data
 * shape — `OllamaConnectionSection` treats "no data" and "404" the same way
 * (an unconfigured connection), so it does not need to special-case the
 * error object; it only reads `data`.
 *
 * `options.enabled` (default true) lets a caller suppress the fetch. The one
 * consumer, `OllamaConnectionSection`, passes `localMode === true` here: the
 * component's own early return already renders nothing off local mode, but
 * hooks fire before that return (rules of hooks), so without this gate a
 * hosted instance would still issue a request the server can only 403 —
 * harmless, but noisy, and it would fire from every settings-page mount.
 */
export function useLlmConnection(provider: ConnectionProvider, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: connectionKey(provider),
    queryFn: () => api<LlmConnection>(`/llm-connections/${provider}`),
    enabled: options?.enabled ?? true,
    retry: false,
  });
}

/**
 * Create or replace the stored connection (plain upsert — the server does
 * NOT contact Ollama here; see llm-connections.ts's "PUT does not validate"
 * comment). Invalidates both the connection row and the model list, since a
 * changed `baseUrl` points the models query at a different server entirely.
 */
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

/** Delete the stored connection. */
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

/**
 * Reachability check against the STORED connection (not a form draft — the
 * server reads the DB row, see llm-connections.ts's testRoute). On success
 * the server advances `lastValidatedAt`, so invalidate the connection query
 * to pick that up.
 */
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

/**
 * Installed models on the caller's stored connection — the FULL list,
 * including tool-incapable ones (`supportsTools: false`). Unlike
 * `useListModels('ollama')` in useAudits.ts (which the universe audit
 * picker uses and which the backend pre-filters to tools-only, since a
 * tool-incapable model cannot run an audit at all), this hook backs the
 * settings picker, which must show a filtered-out model as disabled WITH
 * the reason rather than hide it — a user who pulled `llava` should see why
 * it is unavailable, not wonder where it went.
 *
 * `options.enabled` — see useLlmConnection's doc for why this exists.
 */
export function useOllamaModels(provider: ConnectionProvider, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: modelsKey(provider),
    queryFn: () => api<OllamaModelInfo[]>(`/llm-connections/${provider}/models`),
    enabled: options?.enabled ?? true,
    // A 404 (no connection row) or 503 (unreachable server) both resolve to
    // "nothing to list" from the UI's point of view — neither is transient
    // in the way a dropped packet is, so retrying wastes a round trip
    // against a server the user has, e.g., not started yet.
    retry: false,
  });
}
