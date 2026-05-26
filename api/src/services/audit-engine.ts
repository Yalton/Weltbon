/**
 * Phase 24 — audit-engine.ts: multi-turn tool-use loop with hard caps.
 *
 * The load-bearing core of Phase 24. Orchestrates:
 *
 *   1. Cheap-finds pre-pass (AUDIT-14 / D-06) — zero token cost heuristics
 *      run BEFORE the LLM; their gap_keys / entry IDs exclude those entries
 *      from the structural digest.
 *
 *   2. BYOK key resolution (Phase 22 D-11 four-case null contract).
 *
 *   3. Structural digest build with D-06 excludeEntryIds from cheap-finds.
 *
 *   4. Multi-turn tool-use loop — BEFORE every provider call, the cap
 *      checkpoint (AUDIT-06) fires; any breach terminates with
 *      status='failed', error='budget_exhausted', partial suggestions stay
 *      queryable (D-01).
 *
 *   5. Tool dispatch — `getEntryBody` calls handled locally; `consultedEntryIds`
 *      updated atomically (D-15).
 *
 *   6. Final structured-output turn — Zod-parsed against AuditOutputSchema;
 *      AUDIT-09 validated; surviving suggestions persisted via INSERT …
 *      ON CONFLICT DO NOTHING; gap_key computed engine-side (D-08).
 *
 *   7. Hallucinated entry ID accounting — mandatory atomic INCREMENT on
 *      `audit_runs.hallucinated_entry_reference_count` (AUDIT-09, no fallback).
 *
 *   8. Anthropic prompt caching — `cache_control: { type: 'ephemeral' }` placed
 *      on the static digest prefix when provider='anthropic' AND digest token
 *      count ≥ MIN_CACHEABLE_TOKENS (AUDIT-13 / T-24-04-07).
 *
 *   9. Provider error classification — LLMProviderError → 'provider_error'
 *      taxonomy; raw provider error messages are NEVER written to audit_runs.error
 *      (T-24-04-09).
 *
 *  10. Terminal success — status='succeeded', finishedAt=NOW().
 *
 * Functional service (NOT a class) — mirrors api/src/services/llm-key.ts style.
 *
 * Dependencies (D-05a: factory only — never import concrete provider classes):
 *   - getProvider factory from ../providers/llm/index.js
 *   - LLMProviderError, LLMError, MIN_CACHEABLE_TOKENS from same barrel
 *   - getDecryptedKey from ./llm-key.js
 *   - runCheapFinds from ./cheap-finds.js
 *   - buildStructuralDigest from ./structural-digest.js
 *   - getEntryBody, validateReferencedEntryIds from ./audit-tools.js
 *   - computeGapKey from ./gap-key.js
 *   - AuditOutputSchema, AuditSuggestionStrictSchema from ./audit-schema.js
 *
 * Security invariants:
 *   - T-24-04-05: apiKey never logged; never written to DB
 *   - T-24-04-09: only taxonomy strings written to audit_runs.error
 *   - T-24-04-07: runId, timestamps, userId kept OUT of the cached prefix
 *   - T-24-04-03: gap_key always engine-computed; never LLM-emitted
 */

import { eq, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditRuns, issues, issueEntries, universes } from '../db/schema.js';
import {
  getProvider,
  LLMProviderError,
  LLMError,
  MIN_CACHEABLE_TOKENS,
  type LlmProvider,
} from '../providers/llm/index.js';
import { getDecryptedKey } from './llm-key.js';
import { runCheapFinds, CATEGORY_SEVERITY } from './cheap-finds.js';
import { buildStructuralDigest } from './structural-digest.js';
import { getEntryBody, validateReferencedEntryIds } from './audit-tools.js';
import { computeGapKey } from './gap-key.js';
import { AuditOutputStrictSchema } from './audit-schema.js';
import { env } from '../config.js';
import { trackRun, releaseRun } from './audit-shutdown.js';

// ---------------------------------------------------------------------------
// Engine error taxonomy (T-24-04-09: only these strings write to audit_runs.error)
// ---------------------------------------------------------------------------

/**
 * Engine-owned error taxonomy strings for audit_runs.error.
 *
 * Exported so Plan 06 (audit-recovery) can reuse PROCESS_RESTARTED without
 * duplicating the constant.
 *
 * Raw provider error strings are NEVER written to audit_runs.error (T-24-04-09).
 */
export const ENGINE_ERROR = {
  BUDGET_EXHAUSTED: 'budget_exhausted',
  PROCESS_RESTARTED: 'process_restarted',
  SHUTTING_DOWN: 'shutting_down',
  PROVIDER_ERROR: 'provider_error',
  INVALID_OUTPUT: 'invalid_output',
  UNKNOWN: 'unknown',
  // LLMError variants surfaced verbatim (snake_case) so the UI banner can
  // show a useful, variant-specific message instead of the generic
  // "provider returned an error" fallback. Raw provider error text is still
  // never persisted — only the typed variant name.
  INVALID_API_KEY: 'invalid_api_key',
  INSUFFICIENT_CREDITS: 'insufficient_credits',
  MODEL_NOT_AVAILABLE: 'model_not_available',
  CONTENT_BLOCKED: 'content_blocked',
  RATE_LIMITED: 'rate_limited',
  NETWORK_ERROR: 'network_error',
} as const;

export type EngineErrorTag = (typeof ENGINE_ERROR)[keyof typeof ENGINE_ERROR];

/** Maps a typed LLMError variant to the persisted engine tag. */
function llmErrorToTag(variant: LLMError): EngineErrorTag {
  switch (variant) {
    case LLMError.InvalidApiKey:
      return ENGINE_ERROR.INVALID_API_KEY;
    case LLMError.InsufficientCredits:
      return ENGINE_ERROR.INSUFFICIENT_CREDITS;
    case LLMError.ModelNotAvailable:
      return ENGINE_ERROR.MODEL_NOT_AVAILABLE;
    case LLMError.ContentBlockedBySafetyFilter:
      return ENGINE_ERROR.CONTENT_BLOCKED;
    case LLMError.RateLimited:
      return ENGINE_ERROR.RATE_LIMITED;
    case LLMError.NetworkError:
      return ENGINE_ERROR.NETWORK_ERROR;
    case LLMError.UnknownProviderError:
      return ENGINE_ERROR.PROVIDER_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Tool definition for getEntryBody (sent to both Anthropic and OpenAI providers)
// ---------------------------------------------------------------------------

const getEntryBodyTool = {
  name: 'getEntryBody',
  description:
    'Fetch the full body, summary, tags, and meta of a single entry by ID. ' +
    'Use sparingly — only when the structural digest is insufficient to evaluate a candidate gap.',
  input_schema: {
    type: 'object',
    properties: {
      entryId: {
        type: 'string',
        format: 'uuid',
        description: 'The entry ID to fetch (must be in the valid_entry_ids allowlist).',
      },
    },
    required: ['entryId'],
  },
};

// ---------------------------------------------------------------------------
// Cache-hit ratio tracking (in-process, N=10 cadence)
// ---------------------------------------------------------------------------

let cacheHitRunCount = 0;
const CACHE_HIT_LOG_CADENCE = 10;
const CACHE_HIT_WARN_THRESHOLD = 0.5;
// Rolling window of per-run cache-hit ratios for trailing average
const cacheHitRatioWindow: number[] = [];

function recordCacheHitRatio(runId: string, ratio: number): void {
  cacheHitRatioWindow.push(ratio);
  if (cacheHitRatioWindow.length > CACHE_HIT_LOG_CADENCE) {
    cacheHitRatioWindow.shift();
  }
  cacheHitRunCount++;
  if (cacheHitRunCount % CACHE_HIT_LOG_CADENCE === 0) {
    const trailingAvg =
      cacheHitRatioWindow.reduce((a, b) => a + b, 0) / cacheHitRatioWindow.length;
    console.log(`[audit-engine] cache-hit ratio for run ${runId}: ${ratio.toFixed(2)}`);
    if (trailingAvg < CACHE_HIT_WARN_THRESHOLD) {
      console.warn(
        `[audit-engine] trailing ${CACHE_HIT_LOG_CADENCE}-run cache-hit average is ${trailingAvg.toFixed(2)} (below 0.50 threshold)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency injection interface (for unit testing)
// ---------------------------------------------------------------------------

export interface AuditEngineDeps {
  db?: typeof db;
  getProvider?: typeof getProvider;
  getDecryptedKey?: typeof getDecryptedKey;
  runCheapFinds?: typeof runCheapFinds;
  buildStructuralDigest?: typeof buildStructuralDigest;
  getEntryBody?: typeof getEntryBody;
  validateReferencedEntryIds?: typeof validateReferencedEntryIds;
  computeGapKey?: typeof computeGapKey;
  /** Override config caps for unit-testing. */
  cfg?: {
    auditMaxToolCalls?: number;
    auditMaxWallClockMs?: number;
    auditMaxCostUsd?: number;
    auditMaxTokensTotal?: number;
    llmKeyEncryptionKey?: string | undefined;
  };
}

// ---------------------------------------------------------------------------
// runAudit — main engine entry point
// ---------------------------------------------------------------------------

/**
 * Orchestrate a full audit run for the given runId.
 *
 * Reads the `audit_runs` row, transitions to 'running', runs cheap-finds,
 * builds the structural digest, then enters the multi-turn tool-use loop
 * until a terminal condition (success, cap breach, error, or parse failure).
 *
 * Per D-01 (stream-persist): each suggestion that survives Zod + AUDIT-09
 * validation is INSERTed immediately — partial results survive crashes.
 *
 * Never logs raw `apiKey` or raw provider error text (T-24-04-05 / T-24-04-09).
 *
 * @param runId - The UUID of the audit_runs row to execute.
 * @param deps  - Optional overrides for unit-testing (db, provider, config).
 */
/**
 * Locate and parse a JSON object inside the model's final-turn text.
 *
 * Three fallbacks, in order:
 *   1. Bare `JSON.parse(text)` — Claude 3.x usually emits clean JSON.
 *   2. ```json … ``` fenced code block (or unlabeled ``` … ```) — Claude 4.x
 *      defaults. Captures the first fenced region; non-greedy.
 *   3. First `{` to last `}` slice — last-resort scan when prose surrounds
 *      the JSON without fences.
 *
 * Throws SyntaxError if none of the three paths yield valid JSON. The caller
 * is the engine's final-output catch block, which logs the failure and the
 * raw text preview.
 *
 * Returns `unknown` so the caller MUST still validate shape via the strict
 * Zod schema — this function only widens LOCATION tolerance, not SHAPE.
 */
function extractJsonFromResponseText(text: string): unknown {
  if (!text) return JSON.parse('{}');
  // Path 1
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  // Path 2: fenced ``` block (with or without `json` label)
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      /* fall through */
    }
  }
  // Path 3: first { to matching last }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      /* fall through */
    }
  }
  throw new SyntaxError('No parseable JSON object found in model response text');
}

export async function runAudit(runId: string, deps?: AuditEngineDeps): Promise<void> {
  // Resolve injected vs real dependencies
  const _db = deps?.db ?? db;
  const _getProvider = deps?.getProvider ?? getProvider;
  const _getDecryptedKey = deps?.getDecryptedKey ?? getDecryptedKey;
  const _runCheapFinds = deps?.runCheapFinds ?? runCheapFinds;
  const _buildStructuralDigest = deps?.buildStructuralDigest ?? buildStructuralDigest;
  const _getEntryBody = deps?.getEntryBody ?? getEntryBody;
  const _validateReferencedEntryIds = deps?.validateReferencedEntryIds ?? validateReferencedEntryIds;
  const _computeGapKey = deps?.computeGapKey ?? computeGapKey;

  // Local helper that uses the injected _db (important for unit test isolation)
  async function markFailed(failRunId: string, errorTag: EngineErrorTag): Promise<void> {
    await _db()
      .update(auditRuns)
      .set({ status: 'failed', error: errorTag, finishedAt: new Date() })
      .where(eq(auditRuns.id, failRunId));
  }

  // Load config (merge injected overrides for test cap tuning)
  const cfg = env();
  const maxToolCalls = deps?.cfg?.auditMaxToolCalls ?? cfg.auditMaxToolCalls;
  const maxWallClockMs = deps?.cfg?.auditMaxWallClockMs ?? cfg.auditMaxWallClockMs;
  const maxCostUsd = deps?.cfg?.auditMaxCostUsd ?? cfg.auditMaxCostUsd;
  const maxTokensTotal = deps?.cfg?.auditMaxTokensTotal ?? cfg.auditMaxTokensTotal;
  const encryptionKey =
    deps?.cfg?.llmKeyEncryptionKey !== undefined
      ? deps.cfg.llmKeyEncryptionKey
      : cfg.llmKeyEncryptionKey;

  // ---------------------------------------------------------------------------
  // Step 1: Transition to 'running' and load run + universe context
  // ---------------------------------------------------------------------------

  await _db()
    .update(auditRuns)
    .set({ status: 'running' })
    .where(eq(auditRuns.id, runId));

  // Register this run in the in-flight Set immediately after status='running'.
  // releaseRun is called in the finally block below at every terminal exit path.
  trackRun(runId);

  try {

  const runRows = await _db()
    .select({
      id: auditRuns.id,
      universeId: auditRuns.universeId,
      userId: auditRuns.userId,
      provider: auditRuns.provider,
      model: auditRuns.model,
      scope: auditRuns.scope,
      scopeEntryId: auditRuns.scopeEntryId,
    })
    .from(auditRuns)
    .where(eq(auditRuns.id, runId))
    .limit(1);

  if (runRows.length === 0) {
    // Row disappeared between trigger and execution — nothing to fail
    return;
  }

  const run = runRows[0];
  const { universeId, userId, provider, model } = run;

  // Defense in depth: load universe to verify audit_enabled (routes enforce, but
  // a race between flag-flip and unawaited engine execution is possible).
  const universeRows = await _db()
    .select({ auditEnabled: universes.auditEnabled })
    .from(universes)
    .where(eq(universes.id, universeId))
    .limit(1);

  if (universeRows.length === 0 || !universeRows[0].auditEnabled) {
    // Universe deleted or audit disabled after trigger — abort silently.
    await markFailed(runId, ENGINE_ERROR.UNKNOWN);
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 2: BYOK key resolution (four-case null contract — Phase 22 D-11)
  // ---------------------------------------------------------------------------

  const apiKey = await _getDecryptedKey(userId, provider as LlmProvider, encryptionKey);
  if (apiKey === null) {
    await markFailed(runId, ENGINE_ERROR.PROVIDER_ERROR);
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 2.5: Dismissed-set query (Phase 25 D-11, AISSUE-05) — MUST run before
  // cheap-finds AND before structural-digest build so the gap_key set is
  // available to both the cheap-finds pre-pass and the LLM-output validation
  // step. The auto-stale predicate is applied here so resurfaced gaps return
  // to the active pool automatically.
  // ---------------------------------------------------------------------------
  const dismissedRows = await _db().execute<{ gap_key: string }>(sql`
    SELECT gap_key
    FROM issues
    WHERE universe_id = ${universeId}
      AND source = 'ai'
      AND dismissed_at IS NOT NULL
      AND gap_key IS NOT NULL
      AND (
        dismissal_reason IN ('intentional', 'duplicate_of_human_issue')
        OR (dismissal_reason = 'not_now' AND COALESCE(dismissal_snooze_remaining, 0) > 0)
        OR (
          dismissal_reason = 'inaccurate'
          AND dismissal_snapshot IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(dismissal_snapshot->'entries') AS snap(entry)
            JOIN entries e ON e.id = (snap.entry->>'id')::uuid
            WHERE e.updated_at > (snap.entry->>'updatedAt')::timestamptz
          )
        )
      )
  `);
  // dismissedGapKeys: Set<string> — materialized from the SELECT above.
  // Consumed at Step 3 (cheap-finds arg) and Step 6 (LLM-output validation guard).
  const dismissedGapKeys = new Set<string>(
    // pg returns .rows on QueryResult; drizzle execute returns .rows for raw sql
    (dismissedRows.rows ?? []).map((r) => r.gap_key),
  );

  // CR-03 NOTE: The snooze decrement (D-02) was moved to the terminal-success
  // path (right before status='succeeded'). Running it here would fire even for
  // runs that abort on provider errors or budget breaches after cheap-finds —
  // the user would lose a snooze run even though no real LLM work was done.
  // The decrement now only fires when the run completes to terminal success.

  // ---------------------------------------------------------------------------
  // Step 3: Cheap-finds pre-pass (D-06) — runs BEFORE building the digest
  // ---------------------------------------------------------------------------

  const cheapFindsResult = await _runCheapFinds({
    universeId,
    auditRunId: runId,
    userId,
    provider,
    model,
    dismissedGapKeys,
  });

  // ---------------------------------------------------------------------------
  // Step 4: Structural digest with D-06 exclusion of cheap-find entry IDs
  // ---------------------------------------------------------------------------

  // This is the ONLY path — no post-hoc filtering.
  // The digest API enforces exclusion at serialization time (buildStructuralDigest).
  // BL-03 (Phase 24-09): forward the run's scope contract to the digest builder.
  // When run.scope === 'entry', the digest is narrowed to scope_entry_id + 1-hop
  // link neighbourhood + their timeline pins. When run.scope === 'universe' (or
  // null/legacy), behavior is byte-identical to the pre-fix universe-wide digest.
  const { digest, validEntryIds } = await _buildStructuralDigest(universeId, {
    excludeEntryIds: cheapFindsResult.createdIssueEntryIds,
    scope: run.scope === 'entry' ? 'entry' : 'universe',
    scopeEntryId: run.scopeEntryId,
  });

  // ---------------------------------------------------------------------------
  // Step 5: Build initial message stack with Anthropic cache_control placement
  // ---------------------------------------------------------------------------

  // Count the digest token estimate to determine if cache is applicable.
  // Use the provider's local estimate (free per PROVIDER-07) for pre-call count.
  let digestTokenEstimate = 0;
  try {
    digestTokenEstimate = await _getProvider(provider as LlmProvider).estimate({
      apiKey,
      messages: [{ role: 'user', content: digest }],
      model,
    });
  } catch {
    // Estimate failure is non-fatal; proceed without cache
    digestTokenEstimate = 0;
  }

  const shouldCache =
    provider === 'anthropic' && digestTokenEstimate >= MIN_CACHEABLE_TOKENS;

  // Static digest prefix (cached) + dynamic per-run instructions (not cached).
  // T-24-04-07: runId, timestamps, userId are in the DYNAMIC section only —
  // they must NOT appear in the static cached prefix.
  const staticDigestContent = `You are auditing a world-building universe. Below is the structural digest of the universe. Use the getEntryBody tool to fetch full entry details when needed. DO NOT include a gap_key in your output — the engine computes it.

Structural Digest:
${digest}`;

  const dynamicInstructions = `Run ID: ${runId}
Scope: ${run.scope}${run.scopeEntryId ? ` (entry: ${run.scopeEntryId})` : ''}
Universe ID: ${universeId}
Requested at: ${new Date().toISOString()}

Identify narrative gaps in this universe. For each gap, output a JSON object with:
  - category: one of underdeveloped | missing-link | contradiction | timeline-inconsistency | dangling-thread
  - title: short title (1–500 chars)
  - body: rationale and evidence (1–5000 chars)
  - referenced_entry_ids: array of 1–20 entry UUIDs that are relevant
  - confidence: high | medium | low

When done, return your findings as JSON: { "suggestions": [...] }`;

  // Message types accepted by provider.runAudit
  type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };

  // Build the message stack.
  //
  // Per AUDIT-13: cache_control is placed on the static digest segment only.
  // The dynamic per-run instructions (containing runId, timestamp) come AFTER
  // in a separate message so they are never part of the cached prefix.
  //
  // The RunAuditOpts interface accepts messages as a flat array; we pass the
  // static prefix as a role:'system' message and the dynamic instructions as
  // a role:'user' message. For Anthropic with caching, the system message
  // content is annotated with a CACHE_CONTROL_EPHEMERAL sentinel — this is the
  // signal to the provider that the static prefix should get
  // cache_control: { type: 'ephemeral' } in the underlying SDK call.
  //
  // T-24-04-07 invariant: runId, timestamp, userId are in the DYNAMIC user
  // message only — they must NOT appear in the static cached system prefix.
  const systemContent = shouldCache
    ? `CACHE_CONTROL_EPHEMERAL\n${staticDigestContent}`
    : staticDigestContent;

  const initialMessages: Msg[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: dynamicInstructions },
  ];

  // ---------------------------------------------------------------------------
  // Step 6: Multi-turn tool-use loop
  // ---------------------------------------------------------------------------

  let toolCalls = 0;
  let totalCost = 0;
  let totalTokens = 0;
  const startedAt = Date.now();
  const consultedEntryIds: string[] = [];
  let partialPersistedMarked = false;
  let messages: Msg[] = [...initialMessages];
  let anyValidSuggestions = false;

  // eslint-disable-next-line no-constant-condition
  loop: while (true) {
    // -------------------------------------------------------------------------
    // Cap-enforcement checkpoint (AUDIT-06) — fires BEFORE every provider call
    // Order: tool_call_count, cost, tokens, wall_clock
    // -------------------------------------------------------------------------
    if (
      toolCalls >= maxToolCalls ||
      totalCost >= maxCostUsd ||
      totalTokens >= maxTokensTotal ||
      Date.now() - startedAt >= maxWallClockMs
    ) {
      await markFailed(runId, ENGINE_ERROR.BUDGET_EXHAUSTED);
      return;
    }

    // BL-04 (Phase 24-10): compute the per-turn wall-clock budget. If <= 0 here,
    // the pre-call gate above should have caught it, but this defensive check
    // ensures the per-turn race below is never armed with a non-positive timeout
    // (setTimeout(0) racing a microtask is undefined behavior in practice).
    const remainingMs = maxWallClockMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      await markFailed(runId, ENGINE_ERROR.BUDGET_EXHAUSTED);
      return;
    }

    // -------------------------------------------------------------------------
    // Provider call — single turn
    // -------------------------------------------------------------------------
    let result: {
      text: string;
      toolUse: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationInputTokens: number;
        cacheReadInputTokens: number;
      };
      costUsd: number;
    };

    // BL-04 (Phase 24-10): race the provider call against the remaining wall-clock budget.
    // A single hung provider call (e.g., network stall, model server timeout) cannot
    // exceed the wall-clock cap — the timeout sentinel resolves the race first and
    // we fail with budget_exhausted. The pre-call gate alone is insufficient because
    // it only fires on the NEXT loop iteration, which never comes if the call hangs.
    const PER_TURN_TIMEOUT = Symbol('BL-04 per-turn wall-clock timeout');
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const providerCall = _getProvider(provider as LlmProvider).runAudit({
        apiKey,
        messages,
        model,
        tools: [getEntryBodyTool],
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(PER_TURN_TIMEOUT), remainingMs);
      });
      result = await Promise.race([providerCall, timeoutPromise]);
    } catch (err) {
      if (err === PER_TURN_TIMEOUT) {
        // Per-turn wall-clock breach — treat identically to a post-call wall-clock cap hit.
        await markFailed(runId, ENGINE_ERROR.BUDGET_EXHAUSTED);
        return;
      }
      if (err instanceof LLMProviderError) {
        // T-24-04-09: only taxonomy string written; raw provider error text is never persisted.
        // The typed variant name itself is safe to surface — it carries no provider message text.
        await markFailed(runId, llmErrorToTag(err.variant));
        return;
      }
      // Non-provider errors (programming errors, network timeouts not wrapped) — re-throw
      throw err;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    // -------------------------------------------------------------------------
    // Telemetry update — atomic += increments (sql template literal)
    // -------------------------------------------------------------------------
    const turnToolCalls = result.toolUse.length;
    const turnCachedTokens = result.usage.cacheReadInputTokens;
    const turnPromptTokens = result.usage.inputTokens + result.usage.cacheCreationInputTokens;
    const turnCompletionTokens = result.usage.outputTokens;
    const turnTotalTokens =
      result.usage.inputTokens +
      result.usage.outputTokens +
      result.usage.cacheCreationInputTokens +
      result.usage.cacheReadInputTokens;

    await _db()
      .update(auditRuns)
      .set({
        promptTokens: sql`${auditRuns.promptTokens} + ${turnPromptTokens}`,
        completionTokens: sql`${auditRuns.completionTokens} + ${turnCompletionTokens}`,
        cachedTokens: sql`${auditRuns.cachedTokens} + ${turnCachedTokens}`,
        toolCallCount: sql`${auditRuns.toolCallCount} + ${turnToolCalls}`,
        costUsd: sql`${auditRuns.costUsd} + ${result.costUsd}`,
      })
      .where(eq(auditRuns.id, runId));

    totalCost += result.costUsd;
    totalTokens += turnTotalTokens;
    toolCalls += turnToolCalls;

    // BL-04 (Phase 24-10): post-call cap recheck. The pre-call gate alone allows a
    // single oversized turn to slip through (e.g., a turn returning costUsd=$10 with
    // a $1 cap — the pre-call gate saw $0.30 and let it through; the post-call gate
    // now sees $10.30 and fires). This check fires on EVERY turn (tool-use and
    // final-answer alike), so a single-turn overspend cannot reach the
    // success-transition branch at the bottom of the loop. Mirrors the predicates of
    // the pre-call gate above to preserve a single source of truth for cap semantics.
    if (
      toolCalls >= maxToolCalls ||
      totalCost >= maxCostUsd ||
      totalTokens >= maxTokensTotal ||
      Date.now() - startedAt >= maxWallClockMs
    ) {
      await markFailed(runId, ENGINE_ERROR.BUDGET_EXHAUSTED);
      return;
    }

    // Track cache-hit ratio (AUDIT-13)
    if (turnPromptTokens > 0) {
      const ratio = turnCachedTokens / (turnPromptTokens + turnCachedTokens);
      recordCacheHitRatio(runId, ratio);
    }

    // -------------------------------------------------------------------------
    // Tool-use branch: dispatch each getEntryBody call and feed back as tool_result
    // -------------------------------------------------------------------------
    if (result.toolUse.length > 0) {
      // Append the assistant's tool-use turn
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result.toolUse) },
      ];

      const toolResults: Msg[] = [];
      for (const toolCall of result.toolUse) {
        if (toolCall.name === 'getEntryBody') {
          const entryId = toolCall.input.entryId as string | undefined;
          if (entryId) {
            const entry = await _getEntryBody(universeId, entryId);
            if (entry !== null) {
              // Append to consulted_entry_ids (D-15) — atomic sql array append.
              //
              // Phase 26-02 / AUDIT-07 / D-08: bump analyzed_entries by 1 in the
              // SAME UPDATE statement (single SQL round-trip, no read-then-write
              // race). The increment co-locates with consultedEntryIds because
              // BOTH observability columns advance together on every entry-body
              // materialization. Per AUDIT-04 the structural digest is
              // bodies-NONE — the ONLY path that materializes an entry body is
              // this getEntryBody tool call, so the per-tool-call increment is
              // exhaustive for D-08's partial-coverage heuristic
              // (analyzed_entries < 0.5 × total_entries → "Partial coverage"
              // chip in the completion banner).
              await _db()
                .update(auditRuns)
                .set({
                  consultedEntryIds: sql`${auditRuns.consultedEntryIds} || ARRAY[${entryId}::uuid]`,
                  analyzedEntries: sql`${auditRuns.analyzedEntries} + 1`,
                })
                .where(eq(auditRuns.id, runId));
              consultedEntryIds.push(entryId);
              toolResults.push({
                role: 'tool',
                content: JSON.stringify({
                  tool_call_id: toolCall.id,
                  content: JSON.stringify(entry),
                }),
              });
            } else {
              toolResults.push({
                role: 'tool',
                content: JSON.stringify({
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ error: 'Entry not found' }),
                }),
              });
            }
          }
        }
      }

      messages = [...messages, ...toolResults];
      continue loop;
    }

    // -------------------------------------------------------------------------
    // Final structured-output branch: parse + validate + persist
    // -------------------------------------------------------------------------

    // Try to parse the final answer
    let parsed: { suggestions: Array<{
      category: string;
      title: string;
      body: string;
      referenced_entry_ids: string[];
      confidence: string;
    }> } | null = null;

    try {
      // BL-02 / T-24-04-03: strict-mode parse is the ONLY parse — rejects LLM-smuggled
      // extra fields (e.g., gap_key) at both the envelope and suggestion levels.
      // A Zod throw here is caught immediately below and mapped to INVALID_OUTPUT.
      //
      // Claude 4.x routinely (a) prepends a one-line preamble and (b) wraps the
      // JSON in a ```json fenced block, even when the prompt asks for bare JSON.
      // The extractor walks three fallbacks in order: bare parse → fenced block
      // → first-`{` to last-`}` slice. This preserves the strict Zod validation
      // (extra fields still get rejected) — we only widen the JSON LOCATION
      // tolerance, not the SHAPE tolerance.
      const raw = extractJsonFromResponseText(result.text ?? '');
      parsed = AuditOutputStrictSchema.parse(raw);
    } catch (parseErr) {
      // Diagnostic surface (matches the anthropic provider pattern). Without
      // this, INVALID_OUTPUT is a black hole — operators can't tell whether
      // the model returned prose, wrapped JSON in fences, smuggled extra
      // fields, or returned empty text. T-24-04-09 forbids persisting raw
      // text to the DB; stderr is the appropriate diagnostic channel.
      const textPreview =
        result.text === undefined || result.text === null
          ? '(no text in final turn)'
          : result.text.length > 800
            ? `${result.text.slice(0, 800)}…(truncated, total ${result.text.length} chars)`
            : result.text;
      const errMsg =
        parseErr instanceof Error
          ? `${parseErr.constructor.name}: ${parseErr.message}`
          : String(parseErr);
      console.error(
        `[audit-engine] INVALID_OUTPUT run=${runId} parseErr=${errMsg} resultText=${JSON.stringify(textPreview)}`,
      );
      // Zod parse failure or JSON parse failure
      if (!anyValidSuggestions) {
        await markFailed(runId, ENGINE_ERROR.INVALID_OUTPUT);
      } else {
        // Some suggestions already persisted — succeed with what we have
        await _db()
          .update(auditRuns)
          .set({ status: 'succeeded', finishedAt: new Date() })
          .where(eq(auditRuns.id, runId));
      }
      return;
    }

    const rawSuggestions = parsed.suggestions;

    // Convert to AuditSuggestion shape for validateReferencedEntryIds
    const auditSuggestions = rawSuggestions.map((s) => ({
      category: s.category as import('../types/audit-suggestion.js').AuditCategory,
      referencedEntryIds: s.referenced_entry_ids,
      // Phase 23 fields (kept for compatibility with validateReferencedEntryIds signature)
      rationale: s.body,
      evidence: s.body,
    }));

    // AUDIT-09: drop suggestions with hallucinated entry IDs
    const validateResult = await _validateReferencedEntryIds(universeId, auditSuggestions);
    const { valid: validSuggestions, droppedCount } = validateResult;

    // Mandatory hallucinated_entry_reference_count increment (AUDIT-09 — no fallback)
    if (droppedCount > 0) {
      await _db()
        .update(auditRuns)
        .set({
          hallucinatedEntryReferenceCount: sql`${auditRuns.hallucinatedEntryReferenceCount} + ${droppedCount}`,
        })
        .where(eq(auditRuns.id, runId));
    }

    // Persist each surviving suggestion (stream-persist D-01)
    for (let i = 0; i < validSuggestions.length; i++) {
      const validSugg = validSuggestions[i];
      const rawSugg = rawSuggestions.find(
        (r) => r.referenced_entry_ids === validSugg.referencedEntryIds ||
               r.referenced_entry_ids.join(',') === validSugg.referencedEntryIds.join(','),
      ) ?? rawSuggestions[i];

      if (!rawSugg) continue;

      const gapKey = _computeGapKey(
        universeId,
        validSugg.category,
        validSugg.referencedEntryIds,
        rawSugg.title,
      );

      // AISSUE-05: dismissed gap_key — skip persistence (NOT a hallucination).
      // The gap was already dismissed by the user; the LLM re-suggested it but
      // the engine suppresses it here before any DB write. This guard fires
      // BEFORE the AUDIT-09 collision counter and BEFORE the ON CONFLICT insert.
      if (dismissedGapKeys.has(gapKey)) {
        continue;
      }

      const severity = CATEGORY_SEVERITY[validSugg.category] ?? 'minor';

      // INSERT with ON CONFLICT DO NOTHING (D-11)
      const inserted = await _db()
        .insert(issues)
        .values({
          universeId,
          title: rawSugg.title,
          description: rawSugg.body,
          severity,
          source: 'ai',
          gapKey,
          model,
          auditRunId: runId,
          dismissalSnapshot: null,
          category: validSugg.category,  // CR-01: AuditCategory column — was missing, causing category=NULL
        })
        .onConflictDoNothing()
        .returning({ id: issues.id });

      if (inserted.length === 0) {
        // gap_key collision — increment collision counter (D-11)
        await _db()
          .update(auditRuns)
          .set({
            gapKeyCollisionCount: sql`${auditRuns.gapKeyCollisionCount} + 1`,
          })
          .where(eq(auditRuns.id, runId));
      } else {
        anyValidSuggestions = true;
        const issueId = inserted[0].id;

        // Write issueEntries join rows for referenced_entry_ids
        if (validSugg.referencedEntryIds.length > 0) {
          // Filter to IDs actually in the universe (validEntryIds from digest)
          const validSet = new Set(validEntryIds);
          const entryIdsToInsert = validSugg.referencedEntryIds.filter((id) =>
            validSet.has(id),
          );
          if (entryIdsToInsert.length > 0) {
            await _db()
              .insert(issueEntries)
              .values(entryIdsToInsert.map((entryId) => ({ issueId, entryId })))
              .onConflictDoNothing();
          }
        }

        // Mark first stream-persist (D-01)
        if (!partialPersistedMarked) {
          partialPersistedMarked = true;
          await _db()
            .update(auditRuns)
            .set({ partialSuggestionsPersistedAt: new Date() })
            .where(eq(auditRuns.id, runId));
        }
      }
    }

    // CR-03: Decrement snooze counters for active 'not_now' dismissals here at
    // terminal success (D-02). Moving from engine entry ensures the decrement only
    // fires on runs that actually completed LLM work — BYOK failures, universe-
    // disabled early exits, or provider errors during the loop do NOT consume a
    // snooze step. Separate statement so a failed decrement doesn't affect run status.
    await _db().execute(sql`
      UPDATE issues
      SET dismissal_snooze_remaining = dismissal_snooze_remaining - 1,
          updated_at = NOW()
      WHERE universe_id = ${universeId}
        AND source = 'ai'
        AND dismissed_at IS NOT NULL
        AND dismissal_reason = 'not_now'
        AND COALESCE(dismissal_snooze_remaining, 0) > 0
    `);

    // Terminal success
    await _db()
      .update(auditRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(auditRuns.id, runId));

    return;
  }

  } finally {
    // Release the in-flight Set entry at every terminal exit path:
    // succeeded, budget_exhausted, provider_error, invalid_output, unknown, or re-throw.
    // Any run still in-flight at SIGTERM expiry becomes a process_restarted orphan
    // on next boot via recoverOrphanAuditRuns (AUDIT-12).
    releaseRun(runId);
  }
}
