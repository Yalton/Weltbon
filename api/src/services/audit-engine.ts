
import { z } from 'zod';
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
import { resolveCredential, resolveSharedGrantCredential } from './llm-credential.js';
import type { ProviderCredential } from '../providers/llm/interface.js';
import {
  getSharedAuditReservation,
  roundUpToSixDecimals,
  settleSharedAuditReservation,
  SharedLlmError,
} from './llm-sharing.js';
import { runCheapFinds, CATEGORY_SEVERITY } from './cheap-finds.js';
import { buildStructuralDigest } from './structural-digest.js';
import { getEntryBody, validateReferencedEntryIds } from './audit-tools.js';
import { computeGapKey } from './gap-key.js';
import { AuditOutputStrictSchema } from './audit-schema.js';
import { env } from '../config.js';
import { trackRun, releaseRun } from './audit-shutdown.js';


export const ENGINE_ERROR = {
  BUDGET_EXHAUSTED: 'budget_exhausted',
  PROCESS_RESTARTED: 'process_restarted',
  SHUTTING_DOWN: 'shutting_down',
  PROVIDER_ERROR: 'provider_error',
  INVALID_OUTPUT: 'invalid_output',
  UNKNOWN: 'unknown',
  SHARED_ACCESS_REVOKED: 'shared_access_revoked',
  SHARED_CREDENTIAL_UNAVAILABLE: 'shared_credential_unavailable',
  INVALID_API_KEY: 'invalid_api_key',
  INSUFFICIENT_CREDITS: 'insufficient_credits',
  MODEL_NOT_AVAILABLE: 'model_not_available',
  CONTEXT_TRUNCATED: 'context_truncated',
  CONTENT_BLOCKED: 'content_blocked',
  RATE_LIMITED: 'rate_limited',
  NETWORK_ERROR: 'network_error',
} as const;

export type EngineErrorTag = (typeof ENGINE_ERROR)[keyof typeof ENGINE_ERROR];

function llmErrorToTag(variant: LLMError): EngineErrorTag {
  switch (variant) {
    case LLMError.InvalidApiKey:
      return ENGINE_ERROR.INVALID_API_KEY;
    case LLMError.InsufficientCredits:
      return ENGINE_ERROR.INSUFFICIENT_CREDITS;
    case LLMError.ModelNotAvailable:
      return ENGINE_ERROR.MODEL_NOT_AVAILABLE;
    case LLMError.ContextTruncated:
      return ENGINE_ERROR.CONTEXT_TRUNCATED;
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

const emitFindingsTool = {
  name: 'emit_findings',
  description:
    'Call this tool exactly once when you are ready to deliver your complete list ' +
    'of audit findings. The `suggestions` array MUST conform to the schema; the ' +
    'engine validates with AuditOutputStrictSchema (strict mode — extra fields ' +
    'are rejected). Do not emit findings as prose text — they will be rejected.',
  input_schema: z.toJSONSchema(AuditOutputStrictSchema),
};


let cacheHitRunCount = 0;
const CACHE_HIT_LOG_CADENCE = 10;
const CACHE_HIT_WARN_THRESHOLD = 0.5;
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


export interface AuditEngineDeps {
  db?: typeof db;
  getProvider?: typeof getProvider;
  resolveCredential?: typeof resolveCredential;
  resolveSharedGrantCredential?: typeof resolveSharedGrantCredential;
  settleSharedAuditReservation?: typeof settleSharedAuditReservation;
  getSharedAuditReservation?: typeof getSharedAuditReservation;
  runCheapFinds?: typeof runCheapFinds;
  buildStructuralDigest?: typeof buildStructuralDigest;
  getEntryBody?: typeof getEntryBody;
  validateReferencedEntryIds?: typeof validateReferencedEntryIds;
  computeGapKey?: typeof computeGapKey;
  cfg?: {
    auditMaxToolCalls?: number;
    auditMaxWallClockMs?: number;
    auditMaxCostUsd?: number;
    auditMaxTokensTotal?: number;
    llmKeyEncryptionKey?: string | undefined;
  };
}


export async function runAudit(runId: string, deps?: AuditEngineDeps): Promise<void> {
  const _db = deps?.db ?? db;
  const _getProvider = deps?.getProvider ?? getProvider;
  const _resolveCredential = deps?.resolveCredential ?? resolveCredential;
  const _resolveSharedGrantCredential =
    deps?.resolveSharedGrantCredential ?? resolveSharedGrantCredential;
  const _settleSharedAuditReservation =
    deps?.settleSharedAuditReservation ?? settleSharedAuditReservation;
  const _getSharedAuditReservation =
    deps?.getSharedAuditReservation ?? getSharedAuditReservation;
  const _runCheapFinds = deps?.runCheapFinds ?? runCheapFinds;
  const _buildStructuralDigest = deps?.buildStructuralDigest ?? buildStructuralDigest;
  const _getEntryBody = deps?.getEntryBody ?? getEntryBody;
  const _validateReferencedEntryIds = deps?.validateReferencedEntryIds ?? validateReferencedEntryIds;
  const _computeGapKey = deps?.computeGapKey ?? computeGapKey;

  const shared = {
    active: false,
    grantId: null as string | null,
    outcome: null as 'succeeded' | 'failed' | null,
    costUsd: 0,
  };

  async function markFailed(failRunId: string, errorTag: EngineErrorTag): Promise<void> {
    shared.outcome = 'failed';
    await _db()
      .update(auditRuns)
      .set({ status: 'failed', error: errorTag, finishedAt: new Date() })
      .where(eq(auditRuns.id, failRunId));
  }

  async function settleSharedRun(): Promise<void> {
    if (!shared.active) return;
    try {
      await _settleSharedAuditReservation(
        runId,
        shared.outcome ?? 'released',
        shared.outcome === null ? 0 : await settleableCostUsd(),
      );
    } catch (err) {
      if (err instanceof SharedLlmError && err.code === 'shared_audit_reservation_not_found') {
        return;
      }
      console.error('[audit-engine] shared settlement failed; reservation left for boot recovery:', runId);
    }
  }

  async function settleableCostUsd(): Promise<number> {
    try {
      const [row] = await _db()
        .select({ costUsd: auditRuns.costUsd })
        .from(auditRuns)
        .where(eq(auditRuns.id, runId))
        .limit(1);
      if (row?.costUsd !== undefined && row.costUsd !== null) {
        const recorded = Number(row.costUsd);
        if (Number.isFinite(recorded) && recorded >= 0) return recorded;
      }
    } catch {
    }
    return Math.max(0, roundUpToSixDecimals(shared.costUsd));
  }

  const cfg = env();
  const maxToolCalls = deps?.cfg?.auditMaxToolCalls ?? cfg.auditMaxToolCalls;
  const maxWallClockMs = deps?.cfg?.auditMaxWallClockMs ?? cfg.auditMaxWallClockMs;
  let maxCostUsd = deps?.cfg?.auditMaxCostUsd ?? cfg.auditMaxCostUsd;
  const maxTokensTotal = deps?.cfg?.auditMaxTokensTotal ?? cfg.auditMaxTokensTotal;
  const encryptionKey =
    deps?.cfg?.llmKeyEncryptionKey !== undefined
      ? deps.cfg.llmKeyEncryptionKey
      : cfg.llmKeyEncryptionKey;

  async function sharedAccessCheckpoint(): Promise<EngineErrorTag | null> {
    if (!shared.active || shared.grantId === null) return null;
    const stored = await _resolveSharedGrantCredential(
      userIdForCheckpoint,
      shared.grantId,
      providerForCheckpoint as LlmProvider,
      encryptionKey,
    );
    if (stored.kind === 'revoked') return ENGINE_ERROR.SHARED_ACCESS_REVOKED;
    if (stored.kind === 'unavailable') return ENGINE_ERROR.SHARED_CREDENTIAL_UNAVAILABLE;
    turnCredential = stored.credential;
    return null;
  }

  let userIdForCheckpoint = '';
  let providerForCheckpoint = '';
  let turnCredential: ProviderCredential | null = null;


  await _db()
    .update(auditRuns)
    .set({ status: 'running' })
    .where(eq(auditRuns.id, runId));

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
      credentialSource: auditRuns.credentialSource,
      sharedGrantId: auditRuns.sharedGrantId,
    })
    .from(auditRuns)
    .where(eq(auditRuns.id, runId))
    .limit(1);

  if (runRows.length === 0) {
    return;
  }

  const run = runRows[0];
  const { universeId, userId, provider, model } = run;
  userIdForCheckpoint = userId;
  providerForCheckpoint = provider;

  shared.active = run.credentialSource === 'shared';
  shared.grantId = run.sharedGrantId;

  const universeRows = await _db()
    .select({ auditEnabled: universes.auditEnabled })
    .from(universes)
    .where(eq(universes.id, universeId))
    .limit(1);

  if (universeRows.length === 0 || !universeRows[0].auditEnabled) {
    await markFailed(runId, ENGINE_ERROR.UNKNOWN);
    return;
  }


  let credential: ProviderCredential;
  if (run.credentialSource === 'shared') {
    if (run.sharedGrantId === null) {
      await markFailed(runId, ENGINE_ERROR.SHARED_ACCESS_REVOKED);
      return;
    }

    const stored = await _resolveSharedGrantCredential(
      userId,
      run.sharedGrantId,
      provider as LlmProvider,
      encryptionKey,
    );
    if (stored.kind === 'revoked') {
      await markFailed(runId, ENGINE_ERROR.SHARED_ACCESS_REVOKED);
      return;
    }
    if (stored.kind === 'unavailable') {
      await markFailed(runId, ENGINE_ERROR.SHARED_CREDENTIAL_UNAVAILABLE);
      return;
    }
    credential = stored.credential;

    const reservation = await _getSharedAuditReservation(runId);
    if (reservation === null || reservation.state !== 'reserved') {
      await markFailed(runId, ENGINE_ERROR.UNKNOWN);
      return;
    }
    maxCostUsd = Math.min(maxCostUsd, Number(reservation.reservedUsd));
  } else {
    const own = await _resolveCredential(userId, provider as LlmProvider, encryptionKey);
    if (own === null) {
      await markFailed(runId, ENGINE_ERROR.PROVIDER_ERROR);
      return;
    }
    credential = own;
  }

  const priced = _getProvider(provider as LlmProvider).pricing(model);
  const costUnknown: boolean = priced === undefined;
  let costUnknownLogged = false;
  if (costUnknown && !costUnknownLogged) {
    console.error('[audit-engine] cost_unknown set for model:', { runId, model, provider });
    costUnknownLogged = true;
  }

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
  const dismissedGapKeys = new Set<string>(
    (dismissedRows.rows ?? []).map((r) => r.gap_key),
  );



  const cheapFindsResult = await _runCheapFinds({
    universeId,
    auditRunId: runId,
    userId,
    provider,
    model,
    dismissedGapKeys,
  });


  const { digest, validEntryIds } = await _buildStructuralDigest(universeId, {
    excludeEntryIds: cheapFindsResult.createdIssueEntryIds,
    scope: run.scope === 'entry' ? 'entry' : 'universe',
    scopeEntryId: run.scopeEntryId,
  });


  let digestTokenEstimate = 0;
  try {
    digestTokenEstimate = await _getProvider(provider as LlmProvider).estimate({
      credential,
      messages: [{ role: 'user', content: digest }],
      model,
    });
  } catch {
    digestTokenEstimate = 0;
  }

  const shouldCache =
    provider === 'anthropic' && digestTokenEstimate >= MIN_CACHEABLE_TOKENS;

  const staticDigestContent = `You are auditing a world-building universe. Below is the structural digest of the universe. Use the getEntryBody tool to fetch full entry details when needed. DO NOT include a gap_key in your output — the engine computes it.

Structural Digest:
${digest}`;

  const dynamicInstructions = `Run ID: ${runId}
Scope: ${run.scope}${run.scopeEntryId ? ` (entry: ${run.scopeEntryId})` : ''}
Universe ID: ${universeId}
Requested at: ${new Date().toISOString()}

Identify narrative gaps in this universe. For each gap, the structured findings include:
  - category: one of underdeveloped | missing-link | contradiction | timeline-inconsistency | dangling-thread
  - title: short title (1–500 chars)
  - body: rationale and evidence (1–5000 chars)
  - referenced_entry_ids: array of 1–20 entry UUIDs that are relevant
  - confidence: high | medium | low

When you are ready to deliver your complete list of findings, call the \`emit_findings\` tool exactly once with a single argument \`{ "suggestions": [...] }\`. DO NOT emit findings as prose text — only the \`emit_findings\` tool invocation will be accepted.`;

  type Msg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };

  const systemContent = shouldCache
    ? `CACHE_CONTROL_EPHEMERAL\n${staticDigestContent}`
    : staticDigestContent;

  const initialMessages: Msg[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: dynamicInstructions },
  ];


  let toolCalls = 0;
  let totalCost = 0;
  let totalTokens = 0;
  const startedAt = Date.now();
  const consultedEntryIds: string[] = [];
  let partialPersistedMarked = false;
  let messages: Msg[] = [...initialMessages];
  let anyValidSuggestions = false;

  loop: while (true) {
    if (
      toolCalls >= maxToolCalls ||
      totalCost >= maxCostUsd ||
      totalTokens >= maxTokensTotal ||
      Date.now() - startedAt >= maxWallClockMs
    ) {
      await markFailed(runId, ENGINE_ERROR.BUDGET_EXHAUSTED);
      return;
    }

    const remainingMs = maxWallClockMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      await markFailed(runId, ENGINE_ERROR.BUDGET_EXHAUSTED);
      return;
    }

    // Recheck shared access immediately before every owner-funded provider call.
    const preCallTag = await sharedAccessCheckpoint();
    if (preCallTag !== null) {
      await markFailed(runId, preCallTag);
      return;
    }

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

    const PER_TURN_TIMEOUT = Symbol('BL-04 per-turn wall-clock timeout');
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const providerCall = _getProvider(provider as LlmProvider).runAudit({
        credential: turnCredential ?? credential,
        messages,
        model,
        tools: [getEntryBodyTool, emitFindingsTool],
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(PER_TURN_TIMEOUT), remainingMs);
      });
      result = await Promise.race([providerCall, timeoutPromise]);
    } catch (err) {
      if (err === PER_TURN_TIMEOUT) {
        await markFailed(runId, ENGINE_ERROR.BUDGET_EXHAUSTED);
        return;
      }
      if (err instanceof LLMProviderError) {
        await markFailed(runId, llmErrorToTag(err.variant));
        return;
      }
      throw err;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

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
        costUsd: costUnknown
          ? sql`'0.0000'::numeric(10,4)`
          : sql`${auditRuns.costUsd} + ${result.costUsd}`,
        costUnknown,
      })
      .where(eq(auditRuns.id, runId));

    totalCost += result.costUsd;
    totalTokens += turnTotalTokens;
    toolCalls += turnToolCalls;

    shared.costUsd = costUnknown ? 0 : totalCost;

    const postCallTag = await sharedAccessCheckpoint();
    if (postCallTag !== null) {
      await markFailed(runId, postCallTag);
      return;
    }

    if (
      toolCalls >= maxToolCalls ||
      totalCost >= maxCostUsd ||
      totalTokens >= maxTokensTotal ||
      Date.now() - startedAt >= maxWallClockMs
    ) {
      await markFailed(runId, ENGINE_ERROR.BUDGET_EXHAUSTED);
      return;
    }

    if (turnPromptTokens > 0) {
      const ratio = turnCachedTokens / (turnPromptTokens + turnCachedTokens);
      recordCacheHitRatio(runId, ratio);
    }

    const emitFindingsCall = result.toolUse.find((t) => t.name === 'emit_findings');
    let emitFindingsInput: unknown = undefined;
    if (emitFindingsCall !== undefined) {
      emitFindingsInput = emitFindingsCall.input;
    }

    if (emitFindingsCall === undefined && result.toolUse.length > 0) {
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result.toolUse) },
      ];

      const toolResults: Msg[] = [];
      for (const toolCall of result.toolUse) {
        if (toolCall.name === 'emit_findings') {
          continue;
        }
        if (toolCall.name === 'getEntryBody') {
          const entryId = toolCall.input.entryId as string | undefined;
          if (entryId) {
            const entry = await _getEntryBody(universeId, entryId);
            if (entry !== null) {
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


    let parsed: { suggestions: Array<{
      category: string;
      title: string;
      body: string;
      referenced_entry_ids: string[];
      confidence: string;
    }> } | null = null;

    try {
      if (emitFindingsCall === undefined) {
        throw new Error('emit_findings tool_use missing in final turn');
      }
      parsed = AuditOutputStrictSchema.parse(emitFindingsInput);
    } catch (parseErr) {
      const blockTypes: string[] = result.toolUse.map((t) => `tool_use:${t.name}`);
      if ((result.text ?? '').length > 0) blockTypes.push('text');
      const errMsg =
        parseErr instanceof Error
          ? `${parseErr.constructor.name}: ${parseErr.message}`
          : String(parseErr);
      console.error(
        `[audit-engine] INVALID_OUTPUT run=${runId} parseErr=${errMsg} blockTypes=${JSON.stringify(blockTypes)} model=${model} provider=${provider}`,
      );
      if (!anyValidSuggestions) {
        await markFailed(runId, ENGINE_ERROR.INVALID_OUTPUT);
      } else {
        shared.outcome = 'succeeded';
        await _db()
          .update(auditRuns)
          .set({ status: 'succeeded', finishedAt: new Date() })
          .where(eq(auditRuns.id, runId));
      }
      return;
    }

    const rawSuggestions = parsed.suggestions;

    const auditSuggestions = rawSuggestions.map((s) => ({
      category: s.category as import('../types/audit-suggestion.js').AuditCategory,
      referencedEntryIds: s.referenced_entry_ids,
      rationale: s.body,
      evidence: s.body,
    }));

    const validateResult = await _validateReferencedEntryIds(universeId, auditSuggestions);
    const { valid: validSuggestions, droppedCount } = validateResult;

    if (droppedCount > 0) {
      await _db()
        .update(auditRuns)
        .set({
          hallucinatedEntryReferenceCount: sql`${auditRuns.hallucinatedEntryReferenceCount} + ${droppedCount}`,
        })
        .where(eq(auditRuns.id, runId));
    }

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

      if (dismissedGapKeys.has(gapKey)) {
        continue;
      }

      const severity = CATEGORY_SEVERITY[validSugg.category] ?? 'minor';

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
        await _db()
          .update(auditRuns)
          .set({
            gapKeyCollisionCount: sql`${auditRuns.gapKeyCollisionCount} + 1`,
          })
          .where(eq(auditRuns.id, runId));
      } else {
        anyValidSuggestions = true;
        const issueId = inserted[0].id;

        if (validSugg.referencedEntryIds.length > 0) {
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

        if (!partialPersistedMarked) {
          partialPersistedMarked = true;
          await _db()
            .update(auditRuns)
            .set({ partialSuggestionsPersistedAt: new Date() })
            .where(eq(auditRuns.id, runId));
        }
      }
    }

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

    shared.outcome = 'succeeded';
    await _db()
      .update(auditRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(auditRuns.id, runId));

    return;
  }

  } catch (err) {
    if (shared.active) await markFailed(runId, ENGINE_ERROR.UNKNOWN);
    throw err;
  } finally {
    releaseRun(runId);

    await settleSharedRun();
  }
}
