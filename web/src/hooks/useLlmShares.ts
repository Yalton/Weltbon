/**
 *
 * Wire shape (api/src/routes/llm-shares.ts):
 *   GET    /api/llm-shares                 → { grants: SharedGrant[] }
 *   POST   /api/llm-shares/:id/consent     → SharedConsent   (idempotent, EMPTY body)
 *   DELETE /api/llm-shares/:id/consent     → 204 (void)      (idempotent)
 *
 * A shared connection lets a recipient run audits on an administrator's
 * hosted Anthropic/OpenAI credential, against a monthly allowance. The types
 * below are the recipient's whole view of that arrangement, and what they
 * DON'T carry is the point:
 *
 *   - No key material of any kind. Not the ciphertext, not the iv, not the
 *     authTag, not even the four-character `bodySuffix` that `LlmKey`
 *     legitimately exposes for the user's OWN key. A suffix is a fingerprint
 *     of someone else's secret; the recipient has no use for it and no claim
 *     to it.
 *   - No owner identity. Not an id, not a name, not an email. The server
 *     collapses every owner-side failure into one opaque code for the same
 *     reason (see routes/audits.ts): a recipient who could tell "the
 *     administrator was demoted" from "their key was deleted" has been handed
 *     an oracle for the administrator roster.
 *
 * `disclosure.credentialOwner` is the literal string 'administrator-managed'
 * precisely so the UI can say whose credential it is without naming anyone.
 *
 * The consent POST sends no body at all — the server rejects a non-empty one.
 * There is nothing to send: consent is to a disclosure the server already
 * holds, identified by its policy version, and a body would only invite a
 * future caller to put something in it.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '../api/client';
import { llmModelsKey } from './useAudits';

export type SharedProvider = 'anthropic' | 'openai';

export interface SharedUsage {
  monthStart: string;
  settledUsd: string;
  reservedUsd: string;
  limitUsd: string;
  activeAudits: number;
  maxConcurrentAudits: number;
  completedAudits: number;
  failedAudits: number;
}

export interface SharedDisclosure {
  providerName: string;
  credentialOwner: 'administrator-managed';
  contentLeavesThisInstance: true;
}

export interface SharedGrant {
  id: string;
  provider: SharedProvider;
  status: 'active';
  createdAt: string;
  consentedAt: string | null;
  policyVersion: string;
  disclosure: SharedDisclosure;
  usage: SharedUsage;
}

export interface SharedConsent {
  grantId: string;
  consentedAt: string;
  policyVersion: string;
}

export interface AdminSharedGrant {
  id: string;
  owner: { id: string; displayName: string; email: string };
  recipient: { id: string; displayName: string; email: string };
  provider: SharedProvider;
  status: 'active' | 'revoked';
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  consentedAt: string | null;
  usage: SharedUsage;
}

export const LLM_SHARES_QUERY_KEY = ['llm-shares'] as const;
export const ADMIN_LLM_SHARES_QUERY_KEY = ['admin-llm-shares'] as const;

/**
 * Consent is the thing that decides whether `/llm/models` answers with the
 * credential), so accepting or withdrawing changes an answer cached elsewhere
 * under a different key — with a 30-minute staleTime, which is how long a
 * newly-accepted recipient would otherwise keep seeing an empty model picker.
 *
 * The grant's provider is read from the cached list rather than passed in,
 * because the mutation variables carry only the grant id — and if the list is
 * not cached the model query cannot be either, so there is nothing to do.
 */
function invalidateProviderModels(qc: QueryClient, grantId: string) {
  const cached = qc.getQueryData<{ grants: SharedGrant[] }>(LLM_SHARES_QUERY_KEY);
  const provider = cached?.grants.find((g) => g.id === grantId)?.provider;
  if (provider) qc.invalidateQueries({ queryKey: llmModelsKey(provider) });
}

export function useSharedLlmGrants(): UseQueryResult<{ grants: SharedGrant[] }> {
  return useQuery({
    queryKey: LLM_SHARES_QUERY_KEY,
    queryFn: () => api<{ grants: SharedGrant[] }>('/llm-shares'),
  });
}

export function useConsentSharedLlmGrant(): UseMutationResult<
  SharedConsent,
  Error,
  { grantId: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { grantId: string }) =>
      api<SharedConsent>(`/llm-shares/${vars.grantId}/consent`, { method: 'POST' }),
    onSuccess: (_data, vars, _ctx) => {
      qc.invalidateQueries({ queryKey: LLM_SHARES_QUERY_KEY });
      invalidateProviderModels(qc, vars.grantId);
    },
  });
}

export function useWithdrawSharedLlmConsent(): UseMutationResult<
  void,
  Error,
  { grantId: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { grantId: string }) =>
      api<void>(`/llm-shares/${vars.grantId}/consent`, { method: 'DELETE' }),
    onSuccess: (_data, vars, _ctx) => {
      qc.invalidateQueries({ queryKey: LLM_SHARES_QUERY_KEY });
      invalidateProviderModels(qc, vars.grantId);
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: LLM_SHARES_QUERY_KEY });
    },
  });
}

// Wire shape (api/src/routes/admin-llm-shares.ts, mounted at /api/admin/llm-shares):
//   GET    /api/admin/llm-shares       → AdminSharedGrant[]  (bare array, unlike
//   POST   /api/admin/llm-shares       → AdminSharedGrant (201), body EXACTLY
//   DELETE /api/admin/llm-shares/:id   → 204 (void)
// Every mutation here invalidates BOTH this list and the admin operator-log
// (`['admin-audit-log']`, see useAdminUsers.ts) because granting or revoking
// (admin-llm-shares.ts calls into the same operator-action logging every

export function useAdminSharedLlmGrants(): UseQueryResult<AdminSharedGrant[]> {
  return useQuery({
    queryKey: ADMIN_LLM_SHARES_QUERY_KEY,
    queryFn: () => api<AdminSharedGrant[]>('/admin/llm-shares'),
  });
}

/**
 * Grant a user access to the calling administrator's own hosted credential.
 *
 * The mutation variables ARE the request body, sent unmodified — this is the
 * enforcement point for "no third field, ever": there is no object-spread or
 * default-merge step here that a later edit could widen. If a caller needs a
 * third field it has to change this function's own parameter type, which is
 * a visible, reviewable diff instead of a silent body-shape drift.
 */
export function useCreateAdminSharedLlmGrant(): UseMutationResult<
  AdminSharedGrant,
  Error,
  { recipientUserId: string; provider: SharedProvider }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { recipientUserId: string; provider: SharedProvider }) =>
      api<AdminSharedGrant>('/admin/llm-shares', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ADMIN_LLM_SHARES_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ['admin-audit-log'] });
    },
  });
}

export function useRevokeAdminSharedLlmGrant(): UseMutationResult<
  void,
  Error,
  { grantId: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { grantId: string }) =>
      api<void>(`/admin/llm-shares/${vars.grantId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ADMIN_LLM_SHARES_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ['admin-audit-log'] });
    },
  });
}
