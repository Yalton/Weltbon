
import type { AuditSuggestion } from '../../types/audit-suggestion.js';


export interface ProviderCredential {
  apiKey?: string;
  baseUrl?: string;
  secret?: string;
}


export const MIN_CACHEABLE_TOKENS = 4096;


export enum LLMError {
  RateLimited = 'RateLimited',
  InvalidApiKey = 'InvalidApiKey',
  InsufficientCredits = 'InsufficientCredits',
  ModelNotAvailable = 'ModelNotAvailable',
  ContextTruncated = 'ContextTruncated',
  ContentBlockedBySafetyFilter = 'ContentBlockedBySafetyFilter',
  NetworkError = 'NetworkError',
  UnknownProviderError = 'UnknownProviderError',
}

export class LLMProviderError extends Error {
  public readonly variant: LLMError;
  constructor(variant: LLMError, message: string) {
    super(message);
    this.name = 'LLMProviderError';
    this.variant = variant;
  }
}


export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
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

export interface RunAuditOpts {
  credential: ProviderCredential;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  model?: string;
  tools?: unknown[];
}

export interface RunAuditResult {
  text: string;
  toolUse: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage: NormalizedUsage;
  costUsd: number;
}


export interface LLMProvider {
  validate(credential: ProviderCredential): Promise<void>;

  estimate(opts: {
    credential: ProviderCredential;
    messages: RunAuditOpts['messages'];
    model?: string;
    system?: string;
  }): Promise<number>;

  runAudit(opts: RunAuditOpts): Promise<RunAuditResult>;

  listModels(): ModelListing[];

  pricing(model: string): ModelListing | undefined;
}


export type { AuditSuggestion };
