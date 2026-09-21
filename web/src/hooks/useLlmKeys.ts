/**
 *
 * Wire shape (post-Plan-04 + Plan-05 consent additions):
 *   GET    /api/llm-keys                  → LlmKey[]
 *   POST   /api/llm-keys                  → LlmKey
 *   PUT    /api/llm-keys/:id              → LlmKey
 *   DELETE /api/llm-keys/:id              → 204 (void)
 *   POST   /api/llm-keys/:id/revalidate   → { id, lastValidatedAt }
 *   GET    /api/llm-keys/consent          → { consentedAt: string | null }
 *   POST   /api/llm-keys/consent          → { consentedAt: string } (idempotent)
 *
 * The api() client (web/src/api/client.ts) already prefixes /api and surfaces
 * the server's `error` string verbatim via ApiError.message — the LlmKeys view
 * displays `err.message` directly to honor the canonical 422/503/409 copy
 * pinned in 22-04 SUMMARY.
 *
 * LLMKEY-03 masking invariant (frontend mirror): the LlmKey type intentionally
 * does NOT include `key`, `ciphertext`, `iv`, `authTag`, or `encryptedKeyVersion`.
 * The view never displays plaintext after submission; only `bodySuffix`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmKey {
  id: string;
  provider: LlmProvider;
  bodySuffix: string;
  label: string;
  createdAt: string;
  lastValidatedAt: string | null;
  totalSpentUsd: string;
  costUnknownCount?: number;
}

export interface LlmConsentState {
  consentedAt: string | null;
}

export interface LlmConsentGranted {
  consentedAt: string;
}

export interface RevalidateResult {
  id: string;
  lastValidatedAt: string;
}

const LLM_KEYS_QUERY_KEY = ['llm-keys'] as const;
const LLM_CONSENT_QUERY_KEY = ['llm-consent'] as const;

export function useLlmKeys() {
  return useQuery({
    queryKey: LLM_KEYS_QUERY_KEY,
    queryFn: () => api<LlmKey[]>('/llm-keys'),
    staleTime: 60_000,
  });
}

export function useCreateLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { provider: LlmProvider; key: string; label?: string }) =>
      api<LlmKey>('/llm-keys', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LLM_KEYS_QUERY_KEY });
    },
  });
}

export function useReplaceLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; key: string; label?: string }) =>
      api<LlmKey>(`/llm-keys/${vars.id}`, {
        method: 'PUT',
        body: JSON.stringify({ key: vars.key, label: vars.label }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LLM_KEYS_QUERY_KEY });
    },
  });
}

export function useRevokeLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<void>(`/llm-keys/${vars.id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LLM_KEYS_QUERY_KEY });
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: LLM_KEYS_QUERY_KEY });
    },
  });
}

export function useRevalidateLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<RevalidateResult>(`/llm-keys/${vars.id}/revalidate`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LLM_KEYS_QUERY_KEY });
    },
  });
}

export function useLlmConsent() {
  return useQuery({
    queryKey: LLM_CONSENT_QUERY_KEY,
    queryFn: () => api<LlmConsentState>('/llm-keys/consent'),
  });
}

export function useGrantLlmConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<LlmConsentGranted>('/llm-keys/consent', {
        method: 'POST',
      }),
    onSuccess: (data) => {
      // WR-03 fix: optimistically set the consent query data — drop the
      // so the refetch was a wasted network round-trip; the view's
      // unnecessary GET round-trip rather than the optimistic write.
      qc.setQueryData<LlmConsentState>(LLM_CONSENT_QUERY_KEY, {
        consentedAt: data.consentedAt,
      });
    },
  });
}
