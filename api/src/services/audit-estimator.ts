/**
 * Phase 26 Plan 02 — audit-estimator.ts: pure-function cost-range estimator.
 *
 * Implements the LLMUI-04 cost-range formula and returns the flat
 * AuditEstimate wire shape (api/src/types/audit-suggestion.ts) that both:
 *
 *   - the existing `triggerAuditRoute` (today inlines a single-point estimate
 *     at api/src/routes/audits.ts:226-249), and
 *   - the NEW pre-run estimate endpoint (Plan 26-03 / D-16),
 *
 * will call. Plan 03 will REPLACE the inline single-point estimate with a
 * call to `estimateAudit()` so the dialog disclosure (D-01) and the route
 * share a single source of truth.
 *
 * Pure function: NEVER mutates a DB row. Only:
 *   1. SELECTs the entries count for the universe (and, for entry-scope,
 *      derives the 1-hop neighbourhood size — but per AUDIT-04 the digest
 *      bodies-NONE design means we don't need to load bodies; structural
 *      digest counts suffice).
 *   2. Calls `getProvider(provider).estimate(...)` to get basePromptTokens —
 *      this is the existing PROVIDER-07 local/offline token-count surface
 *      (Anthropic countTokens; OpenAI tiktoken). No billed API call.
 *   3. Looks up PRICING[provider][model] and multiplies against the LLMUI-04
 *      formula constants.
 *
 * Security invariants (T-26-02-01 / T-26-02-04 / T-24-04-05):
 *   - Never logs the raw apiKey.
 *   - Never logs raw provider error text.
 *   - SELECT is scoped to `WHERE universe_id = ?` — no cross-universe leak.
 *   - Ownership/auth is the caller's responsibility (route runs requireUniverse
 *     BEFORE calling estimateAudit; estimator does not authenticate).
 *
 * Heuristic constants (estimator-internal; documented per plan):
 *   - MIN_OUTPUT_TOKENS    = 200    (small successful run, 1-3 suggestions)
 *   - MAX_OUTPUT_TOKENS    = 4_000  (large successful run, hits AUDIT-07 typical max)
 *   - PER_CALL_INPUT_TOKENS  = 1_500  (cached digest replay + tool-call context)
 *   - PER_CALL_OUTPUT_TOKENS = 400    (next tool call decision + small chunk)
 *
 * These are ESTIMATE-only; engine real telemetry overrides at runtime. The
 * estimator deliberately does NOT call buildStructuralDigest — that would
 * be expensive (full universe walk + serialization) for a cost-range UI.
 * Instead, a small placeholder message is passed to `estimate()` for the
 * basePromptTokens count; the engine's actual token count will differ but
 * the cost-range UI is a range anyway.
 */

import { eq } from 'drizzle-orm';
import { db as realDb } from '../db/client.js';
import { entries } from '../db/schema.js';
import { getProvider, PRICING } from '../providers/llm/index.js';
import type { LlmProvider } from '../providers/llm/index.js';
import { env } from '../config.js';
import type {
  AuditEstimate,
  AuditEstimateBreakdown,
} from '../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Heuristic constants (LLMUI-04 formula inputs — see file JSDoc)
// ---------------------------------------------------------------------------

/** Small successful run, 1-3 suggestions returned. */
const MIN_OUTPUT_TOKENS = 200;
/** Large successful run hitting AUDIT-07's typical max suggestion count. */
const MAX_OUTPUT_TOKENS = 4_000;
/** Per-tool-call input: cached digest replay + tool-call context. */
const PER_CALL_INPUT_TOKENS = 1_500;
/** Per-tool-call output: next tool call decision + small chunk. */
const PER_CALL_OUTPUT_TOKENS = 400;

// ---------------------------------------------------------------------------
// Zero breakdown — defensive return for unknown-model fallback
// ---------------------------------------------------------------------------

function zeroBreakdown(scopeEntryCount: number, maxToolCalls: number): AuditEstimateBreakdown {
  return {
    basePromptTokens: 0,
    ratePerMTokIn: 0,
    ratePerMTokOut: 0,
    ratePerMTokCachedRead: 0,
    maxToolCalls,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    perCallInputTokens: PER_CALL_INPUT_TOKENS,
    perCallOutputTokens: PER_CALL_OUTPUT_TOKENS,
    minOutputTokens: MIN_OUTPUT_TOKENS,
    scopeEntryCount,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EstimateInput {
  universeId: string;
  scope: 'universe' | 'entry';
  /** Required when scope='entry'. */
  entryId?: string;
  provider: 'anthropic' | 'openai';
  model: string;
  /** Decrypted plaintext key; NEVER logged. */
  apiKey: string;
  /** Used by the caller's auth path; not consumed by the estimator itself. */
  userId: string;
  /**
   * Dependency injection seam for unit testing. NEVER set this from a route;
   * defaults to the real `db` client. The leading underscore signals the
   * intent: this is private surface, only the test file and the inline-routes
   * caller boundary touches it.
   */
  _db?: typeof realDb;
}

/**
 * Compute the LLMUI-04 cost-range estimate for a planned audit run.
 *
 * Returns:
 *   - { lower, upper, breakdown, model } — all numeric values in USD.
 *   - On unknown model (PRICING lookup miss): lower=0, upper=0, breakdown
 *     fields zeroed (per pricing.ts invariant 2 — caller's UI shows an
 *     "unknown model" banner instead of guessing a price).
 *
 * Does NOT mutate any DB row. Pure compute (+ one read + one local token count).
 */
export async function estimateAudit(input: EstimateInput): Promise<AuditEstimate> {
  const _db = input._db ?? realDb;
  const cfg = env();
  const maxToolCalls = cfg.auditMaxToolCalls;

  // -------------------------------------------------------------------------
  // Step 1: entries count for scope (T-26-02-04: scoped SELECT, no leak)
  //
  // For scope='universe' — total entries in the universe.
  // For scope='entry'  — caller is expected to pass `entryId`; the 1-hop
  //   neighbourhood size matches the engine's narrowed digest (Phase 24 BL-03
  //   / 24-09). For the cost-range estimate we deliberately use the FULL
  //   universe count here as an upper-bound for `scopeEntryCount` rendering
  //   in the dialog — the digest narrowing happens engine-side and reduces
  //   actual token usage at run time (which only makes the estimate more
  //   conservative, never less).
  //   A future revision (Plan 03+) may swap this for an exact neighbourhood
  //   count once the digest API exposes a cheap size-only query.
  // -------------------------------------------------------------------------
  let scopeEntryCount = 0;
  try {
    const rows = await _db()
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.universeId, input.universeId));
    scopeEntryCount = Array.isArray(rows) ? rows.length : 0;
  } catch {
    // Estimate must not fail loudly — fall through to 0 entry count.
    scopeEntryCount = 0;
  }

  // -------------------------------------------------------------------------
  // Step 2: pricing lookup. Unknown model → defensive zero return.
  // -------------------------------------------------------------------------
  const providerPricing = (PRICING as Record<string, Record<string, {
    inputUsdPer1M: number;
    outputUsdPer1M: number;
    cachedInputUsdPer1M: number;
  }>>)[input.provider];
  const rate = providerPricing?.[input.model];

  if (!rate) {
    return {
      lower: 0,
      upper: 0,
      breakdown: zeroBreakdown(scopeEntryCount, maxToolCalls),
      model: { provider: input.provider, name: input.model },
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: basePromptTokens via getProvider().estimate() — local/offline
  // PROVIDER-07 surface (Anthropic countTokens / OpenAI tiktoken). The
  // placeholder message is intentionally small — engine's real digest will
  // tokenize to a different number; the estimator documents this in the
  // dialog as a range, never a point estimate.
  // -------------------------------------------------------------------------
  let basePromptTokens = 0;
  try {
    basePromptTokens = await getProvider(input.provider as LlmProvider).estimate({
      apiKey: input.apiKey,
      messages: [
        // T-26-02-01: apiKey is the only sensitive value in this call — it
        // travels into the provider's local tokenizer, never to the network.
        {
          role: 'user',
          content:
            'Audit estimate placeholder — full structural digest not materialized for the cost-range UI.',
        },
      ],
      model: input.model,
    });
  } catch {
    // T-24-04-09 / T-26-02-01: never log raw provider error text; fall through
    // with basePromptTokens=0 (the UI shows a degenerate but non-fatal range).
    basePromptTokens = 0;
  }

  // -------------------------------------------------------------------------
  // Step 4: LLMUI-04 formula
  //
  //   lower = basePromptTokens × inputRate + minOutputTokens × outputRate
  //
  //   upper = basePromptTokens × inputRate
  //         + AUDIT_MAX_TOOL_CALLS × (perCallInputTokens × cachedReadRate
  //                                   + perCallOutputTokens × outputRate)
  //         + maxOutputTokens × outputRate
  //
  // PRICING units: USD-per-1M-tokens — divide by 1_000_000 to convert.
  // -------------------------------------------------------------------------
  const inputCost = (basePromptTokens / 1_000_000) * rate.inputUsdPer1M;
  const lower = inputCost + (MIN_OUTPUT_TOKENS / 1_000_000) * rate.outputUsdPer1M;

  const perCallCost =
    (PER_CALL_INPUT_TOKENS / 1_000_000) * rate.cachedInputUsdPer1M +
    (PER_CALL_OUTPUT_TOKENS / 1_000_000) * rate.outputUsdPer1M;
  const upper =
    inputCost +
    maxToolCalls * perCallCost +
    (MAX_OUTPUT_TOKENS / 1_000_000) * rate.outputUsdPer1M;

  const breakdown: AuditEstimateBreakdown = {
    basePromptTokens,
    ratePerMTokIn: rate.inputUsdPer1M,
    ratePerMTokOut: rate.outputUsdPer1M,
    ratePerMTokCachedRead: rate.cachedInputUsdPer1M,
    maxToolCalls,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    perCallInputTokens: PER_CALL_INPUT_TOKENS,
    perCallOutputTokens: PER_CALL_OUTPUT_TOKENS,
    minOutputTokens: MIN_OUTPUT_TOKENS,
    scopeEntryCount,
  };

  return {
    lower,
    upper,
    breakdown,
    model: { provider: input.provider, name: input.model },
  };
}

