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
import { AuditOutputSchema, AuditSuggestionStrictSchema } from './audit-schema.js';
import { env } from '../config.js';

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
} as const;

export type EngineErrorTag = (typeof ENGINE_ERROR)[keyof typeof ENGINE_ERROR];

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
  // Step 3: Cheap-finds pre-pass (D-06) — runs BEFORE building the digest
  // ---------------------------------------------------------------------------

  const cheapFindsResult = await _runCheapFinds({
    universeId,
    auditRunId: runId,
    userId,
    provider,
    model,
  });

  // ---------------------------------------------------------------------------
  // Step 4: Structural digest with D-06 exclusion of cheap-find entry IDs
  // ---------------------------------------------------------------------------

  // This is the ONLY path — no post-hoc filtering.
  // The digest API enforces exclusion at serialization time (buildStructuralDigest).
  const { digest, validEntryIds } = await _buildStructuralDigest(universeId, {
    excludeEntryIds: cheapFindsResult.createdIssueEntryIds,
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

    try {
      result = await _getProvider(provider as LlmProvider).runAudit({
        apiKey,
        messages,
        model,
        tools: [getEntryBodyTool],
      });
    } catch (err) {
      if (err instanceof LLMProviderError) {
        // T-24-04-09: only taxonomy string written; raw provider error text is never persisted
        await markFailed(runId, ENGINE_ERROR.PROVIDER_ERROR);
        return;
      }
      // Non-provider errors (programming errors, network timeouts not wrapped) — re-throw
      throw err;
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
              // Append to consulted_entry_ids (D-15) — atomic sql array append
              await _db()
                .update(auditRuns)
                .set({
                  consultedEntryIds: sql`${auditRuns.consultedEntryIds} || ARRAY[${entryId}::uuid]`,
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
      // Try strict parse first (defense in depth against gap_key smuggling T-24-04-03)
      const raw = JSON.parse(result.text || '{}');
      parsed = AuditOutputSchema.parse(raw);
    } catch {
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

    // Terminal success
    await _db()
      .update(auditRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(auditRuns.id, runId));

    return;
  }
}
