/**
 * #50 Task 8 — TanStack Query hooks for /api/llm-shares/*.
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
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '../api/client';

export type SharedProvider = 'anthropic' | 'openai';

export interface SharedUsage {
  /** First of the current UTC month, `YYYY-MM-01`. */
  monthStart: string;
  /** Four-decimal USD strings, as the server formats them. */
  settledUsd: string;
  reservedUsd: string;
  limitUsd: string;
  activeAudits: number;
  maxConcurrentAudits: number;
  completedAudits: number;
  failedAudits: number;
}

export interface SharedDisclosure {
  /** 'Anthropic' | 'OpenAI' — display form, from the server. */
  providerName: string;
  credentialOwner: 'administrator-managed';
  contentLeavesThisInstance: true;
}

export interface SharedGrant {
  id: string;
  provider: SharedProvider;
  status: 'active';
  createdAt: string;
  /** null until the recipient accepts the current disclosure. */
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

/**
 * The administrator-side view, used by the admin screen in Task 9.
 *
 * It names both parties because an administrator granting access legitimately
 * needs to know who they are granting it to — the asymmetry with SharedGrant
 * above is deliberate, not an oversight.
 */
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

/** List the caller's active shared connections, consented or not. */
export function useSharedLlmGrants(): UseQueryResult<{ grants: SharedGrant[] }> {
  return useQuery({
    queryKey: LLM_SHARES_QUERY_KEY,
    queryFn: () => api<{ grants: SharedGrant[] }>('/llm-shares'),
  });
}

/**
 * Accept the disclosure for one grant.
 *
 * No request body: the server rejects a non-empty one, and there is nothing
 * the client could usefully say. Invalidating the list rather than writing
 * the response into the cache is deliberate — consent changes `usage` and
 * `consentedAt` together, and only the server knows the new pair.
 */
export function useConsentSharedLlmGrant(): UseMutationResult<
  SharedConsent,
  Error,
  { grantId: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { grantId: string }) =>
      api<SharedConsent>(`/llm-shares/${vars.grantId}/consent`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LLM_SHARES_QUERY_KEY });
    },
  });
}

/**
 * Withdraw consent for one grant.
 *
 * Idempotent server-side, including when consent was already absent, so a
 * double-click cannot produce a confusing 404. Invalidate on error as well as
 * on success: a failure here usually means the grant changed underneath us,
 * and the list is the thing that says how.
 */
export function useWithdrawSharedLlmConsent(): UseMutationResult<
  void,
  Error,
  { grantId: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { grantId: string }) =>
      api<void>(`/llm-shares/${vars.grantId}/consent`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LLM_SHARES_QUERY_KEY });
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: LLM_SHARES_QUERY_KEY });
    },
  });
}
