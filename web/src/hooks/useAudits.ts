
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from '../api/client';
import type {
  AuditRunStatus,
  AuditEstimate,
  InFlightAuditSummary,
  AuditHistoryRow,
  AuditScope,
  ListingsResult,
  ModelListing,
  ModelListingWithCoverage,
} from '../types/audit';

export type {
  AuditRunStatus,
  AuditEstimate,
  InFlightAuditSummary,
  AuditHistoryRow,
  AuditScope,
  ListingsResult,
  ModelListing,
  ModelListingWithCoverage,
};

export interface AuditRun {
  id: string;
  universeId: string;
  scope: AuditScope;
  scopeEntryId: string | null;
  provider: string;
  model: string;
  status: AuditRunStatus;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  toolCallCount: number;
  costUsd: string;
  costUnknown?: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  suggestionCount: number;
  analyzedEntries?: number;
  partialSuggestionsPersistedAt?: string | null;
  credentialSource?: 'own' | 'shared';
}

export interface StartAuditResponse {
  runId: string;
  estimate: { promptTokens: number; estCostUsd: number };
}

export interface StartAuditVariables {
  scope: AuditScope;
  entryId?: string;
}

export interface UseEstimateAuditOptions {
  enabled?: boolean;
}


export function useStartAudit(
  universeId: string,
): UseMutationResult<StartAuditResponse, Error, StartAuditVariables> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StartAuditVariables) =>
      api<StartAuditResponse>(`/universes/${universeId}/audit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['in-flight-audits'] });
      qc.invalidateQueries({ queryKey: ['audit-history', universeId] });
    },
  });
}

export function useAuditRun(
  universeId: string,
  runId: string | null,
): UseQueryResult<AuditRun> {
  return useQuery({
    queryKey: ['audit-run', universeId, runId],
    queryFn: () => api<AuditRun>(`/universes/${universeId}/audits/${runId}`),
    enabled: !!universeId && !!runId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'succeeded' || data?.status === 'failed') return false;
      const path = typeof window !== 'undefined' ? window.location.pathname : '';
      const visible =
        typeof document !== 'undefined' && document.visibilityState === 'visible';
      // Heuristic: the active-panel routes for an audit run are the universe
      // settings page (audit-history tab) and the entries page (where the
      const onActivePanel = path.includes('/settings') || path.includes('/entries');
      if (onActivePanel && visible) return 1000;
      if (!visible) return 5000;
      return 2000;
    },
  });
}

export function useInFlightAudits(): UseQueryResult<InFlightAuditSummary[]> {
  return useQuery({
    queryKey: ['in-flight-audits'],
    queryFn: () => api<InFlightAuditSummary[]>(`/audits/in-flight`),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && data.length > 0 ? 2000 : 10000;
    },
  });
}

export function useAuditHistory(
  universeId: string,
  opts?: { limit?: number; offset?: number },
): UseQueryResult<{ rows: AuditHistoryRow[]; total: number; hasMore: boolean }> {
  const qs = new URLSearchParams();
  if (opts?.limit !== undefined) qs.set('limit', String(opts.limit));
  if (opts?.offset !== undefined) qs.set('offset', String(opts.offset));
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['audit-history', universeId, opts],
    queryFn: () =>
      api<{ rows: AuditHistoryRow[]; total: number; hasMore: boolean }>(
        `/universes/${universeId}/audits${suffix}`,
      ),
    enabled: !!universeId,
  });
}

export function useEstimateAudit(
  universeId: string | undefined,
  scope: AuditScope,
  entryId?: string,
  provider?: 'anthropic' | 'openai' | 'ollama',
  model?: string,
  options?: UseEstimateAuditOptions,
): UseQueryResult<AuditEstimate> {
  const qs = new URLSearchParams();
  qs.set('scope', scope);
  if (entryId) qs.set('entryId', entryId);
  if (provider) qs.set('provider', provider);
  if (model) qs.set('model', model);
  return useQuery({
    queryKey: ['audit-estimate', universeId, scope, entryId, provider, model],
    queryFn: () =>
      api<AuditEstimate>(`/universes/${universeId}/audits/estimate?${qs}`),
    enabled: !!universeId && (options?.enabled ?? true),
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * Exported so useLlmShares can invalidate it. Accepting or withdrawing a
 * shared connection changes which credential /llm/models resolves through
 * below means a stale answer would otherwise persist for that long.
 */
export function llmModelsKey(provider: 'anthropic' | 'openai' | 'ollama' | undefined) {
  return ['llm-models', provider] as const;
}

export function useListModels(
  provider: 'anthropic' | 'openai' | 'ollama' | undefined,
): UseQueryResult<ListingsResult> {
  return useQuery({
    // that must stay byte-identical and nothing enforcing it is exactly how
    queryKey: llmModelsKey(provider),
    queryFn: () =>
      api<ListingsResult>(`/llm/models?provider=${provider}`),
    enabled: !!provider,
    staleTime: 1_800_000,
    retry: 1,
  });
}
