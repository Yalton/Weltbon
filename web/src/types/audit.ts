
import type { AuditCategory } from '../hooks/useIssues';

export type AuditScope = 'universe' | 'entry';

export type AuditRunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface AuditEstimateBreakdown {
  basePromptTokens: number;
  ratePerMTokIn: number;
  ratePerMTokOut: number;
  ratePerMTokCachedRead: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  perCallInputTokens: number;
  perCallOutputTokens: number;
  minOutputTokens: number;
  scopeEntryCount: number;
}

export interface AuditEstimate {
  lower: number;
  upper: number;
  breakdown: AuditEstimateBreakdown;
  // (routes/audits.ts resolves an endpoint credential, not only a key), so
  model: { provider: 'anthropic' | 'openai' | 'ollama'; name: string };
}

export interface InFlightAuditSummary {
  id: string;
  universeId: string;
  universeName: string;
  scope: AuditScope;
  scopeEntryId: string | null;
  scopeEntryTitle: string | null;
  status: Extract<AuditRunStatus, 'pending' | 'running'>;
  startedAt: string;
  costUsd: string;
  toolCallCount: number;
}

export interface AuditHistoryRow {
  id: string;
  scope: AuditScope;
  scopeEntryId: string | null;
  scopeEntryTitle: string | null;
  provider: string;
  model: string;
  status: AuditRunStatus;
  costUsd: string;
  costUnknown: boolean;
  startedAt: string;
  finishedAt: string | null;
  suggestionsByCategory: Partial<Record<AuditCategory, number>>;
  analyzedEntries: number;
  totalEntries: number | null;
  credentialSource?: 'own' | 'shared';
}


export interface ModelListing {
  id: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
}

export interface ModelListingWithCoverage {
  id: string;
  hasPricing: boolean;
  pricing?: ModelListing;
}

export interface ListingsResult {
  models: ModelListingWithCoverage[];
  source: 'live' | 'cache_stale' | 'pricing_fallback';
  fetchedAt: string;
}
