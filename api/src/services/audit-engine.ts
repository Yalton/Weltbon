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
 *   - resolveCredential from ./llm-credential.js (#48: the single point where
 *     the llm_api_keys table and the llm_connections table meet — replaces
 *     the direct getDecryptedKey call so the engine works for both key-based
 *     and endpoint-based providers without a provider-shaped branch here)
 *   - runCheapFinds from ./cheap-finds.js
 *   - buildStructuralDigest from ./structural-digest.js
 *   - getEntryBody, validateReferencedEntryIds from ./audit-tools.js
 *   - computeGapKey from ./gap-key.js
 *   - AuditOutputSchema, AuditSuggestionStrictSchema from ./audit-schema.js
 *
 * Security invariants:
 *   - T-24-04-05: credential (apiKey / baseUrl / secret) never logged; never
 *     written to DB
 *   - T-24-04-09: only taxonomy strings written to audit_runs.error
 *   - T-24-04-07: runId, timestamps, userId kept OUT of the cached prefix
 *   - T-24-04-03: gap_key always engine-computed; never LLM-emitted
 */

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
  // #50 Task 7 — shared-credential runs only. Kept distinct from
  // PROVIDER_ERROR because they mean something the recipient can act on:
  // the administrator withdrew access, or their key stopped working. A
  // recipient told "provider error" would go looking at their own settings,
  // where there is nothing to fix.
  SHARED_ACCESS_REVOKED: 'shared_access_revoked',
  SHARED_CREDENTIAL_UNAVAILABLE: 'shared_credential_unavailable',
  // LLMError variants surfaced verbatim (snake_case) so the UI banner can
  // show a useful, variant-specific message instead of the generic
  // "provider returned an error" fallback. Raw provider error text is still
  // never persisted — only the typed variant name.
  INVALID_API_KEY: 'invalid_api_key',
  INSUFFICIENT_CREDITS: 'insufficient_credits',
  MODEL_NOT_AVAILABLE: 'model_not_available',
  CONTEXT_TRUNCATED: 'context_truncated',
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
// emit_findings tool (Phase 27 D-09/D-10/D-12)
// ---------------------------------------------------------------------------
//
// emit_findings is the canonical structured-output mechanism for the FINAL
// turn. The model "invokes" the tool to deliver its complete list of audit
// findings; the SDK delivers a pre-parsed JSON object inside `tool_use.input`.
// The engine then Zod-parses `tool_use.input` via AuditOutputStrictSchema
// (the same strict envelope Phase 24 BL-02 added) — invariant preserved, just
// applied to tool_use.input instead of the prior prose-text JSON parse.
//
// Per D-10: prose text in the final turn is a contract violation — the engine
// fails fast with INVALID_OUTPUT (the prior three-fallback extractor is GONE).
// Per D-12: a single emit_findings invocation returns `suggestions: [...]`.
//
// The tool name is literally `emit_findings` (snake_case) — both
// llm-provider-contract.test.ts (coverage point #4) and the Phase 23 OpenAI
// adapter's synthetic toolUse[] entry already assume this name; Phase 27
// makes the engine's tool definition match.
//
// input_schema is derived from the canonical AuditOutputStrictSchema via
// zod 4's built-in z.toJSONSchema() — single source of truth (D-09).
// IMPORTANT: tools are sent to the LLM as a structured-output contract; the
// engine NEVER executes emit_findings server-side (it's not a function call;
// the model's invocation IS the answer).
const emitFindingsTool = {
  name: 'emit_findings',
  description:
    'Call this tool exactly once when you are ready to deliver your complete list ' +
    'of audit findings. The `suggestions` array MUST conform to the schema; the ' +
    'engine validates with AuditOutputStrictSchema (strict mode — extra fields ' +
    'are rejected). Do not emit findings as prose text — they will be rejected.',
  input_schema: z.toJSONSchema(AuditOutputStrictSchema),
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
  resolveCredential?: typeof resolveCredential;
  // #50 Task 7 — shared-credential runs. Injectable for the same reason
  // resolveCredential is: the engine's unit tests drive a db stub and must
  // never reach a real grant table.
  resolveSharedGrantCredential?: typeof resolveSharedGrantCredential;
  settleSharedAuditReservation?: typeof settleSharedAuditReservation;
  // Not named in the Task 7 interface list, but the reservation amount is the
  // run's real cost ceiling and lives in llm_shared_audit_reservations — there
  // is no way to enforce it without reading that row, and no way to unit-test
  // the enforcement without being able to stub the read.
  getSharedAuditReservation?: typeof getSharedAuditReservation;
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
 * Never logs the raw credential or raw provider error text (T-24-04-05 / T-24-04-09).
 *
 * @param runId - The UUID of the audit_runs row to execute.
 * @param deps  - Optional overrides for unit-testing (db, provider, config).
 */
export async function runAudit(runId: string, deps?: AuditEngineDeps): Promise<void> {
  // Resolve injected vs real dependencies
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

  // #50 Task 7 — shared settlement bookkeeping.
  //
  // The plan asked for a terminal helper invoked from every markFailed,
  // success, partial-success and thrown-error path. It is driven from the
  // existing `finally` instead, off this record. Same coverage by
  // construction rather than by enumeration: `finally` already runs at every
  // terminal exit — that is precisely why releaseRun lives there — so a path
  // added later cannot forget to settle. Enumerating ~10 call sites is how a
  // reservation gets stranded, and a stranded reservation blocks its
  // recipient from every future shared audit, permanently.
  const shared = {
    /** True once a shared run's provenance has been loaded. */
    active: false,
    grantId: null as string | null,
    /** Set by markFailed and by the success transitions; null means neither ran. */
    outcome: null as 'succeeded' | 'failed' | null,
    /** Cost to settle against the owner's month. Stays 0 for an unpriced run. */
    costUsd: 0,
  };

  // Local helper that uses the injected _db (important for unit test isolation)
  async function markFailed(failRunId: string, errorTag: EngineErrorTag): Promise<void> {
    shared.outcome = 'failed';
    await _db()
      .update(auditRuns)
      .set({ status: 'failed', error: errorTag, finishedAt: new Date() })
      .where(eq(auditRuns.id, failRunId));
  }

  /**
   * Releases the run's hold on the owner's monthly allowance exactly once.
   *
   * Idempotence is the service's, not ours: settleSharedAuditReservation
   * returns without effect unless the reservation is still `reserved`, under
   * the row lock. This wrapper therefore never has to reason about whether it
   * already ran — which matters, because recovery may also settle the same
   * run after a crash.
   *
   * Never allowed to fail the run. A settlement error is an accounting
   * problem for the operator; turning it into a thrown engine error would
   * additionally lose the audit the user already paid for.
   */
  async function settleSharedRun(): Promise<void> {
    if (!shared.active) return;
    try {
      await _settleSharedAuditReservation(
        runId,
        // No terminal transition ran at all — only reachable if a future
        // early return is added between the run-row load and the first status
        // write. Nothing was charged in that window, so release the hold whole.
        shared.outcome ?? 'released',
        shared.outcome === null ? 0 : await settleableCostUsd(),
      );
    } catch (err) {
      if (err instanceof SharedLlmError && err.code === 'shared_audit_reservation_not_found') {
        // The reservation row is gone. That happens when the run row itself
        // was deleted (the reservation cascades from it) — a universe deleted
        // mid-run, say. Note that llm_shared_usage does NOT cascade, so the
        // recipient's counters are left holding a slot for a run that no
        // longer exists. Nothing this function can do about it: there is no
        // reservation left to read the amount from.
        return;
      }
      // Metadata only — never the recipient, the owner, or any amount. This
      // is the condition that strands a reservation, so it is also what
      // releaseStrandedSharedReservations() exists to repair on next boot.
      console.error('[audit-engine] shared settlement failed; reservation left for boot recovery:', runId);
    }
  }

  /**
   * The amount to settle against the owner's month.
   *
   * The RECORDED `audit_runs.cost_usd` is the source of truth, not the
   * engine's in-memory accumulator. Two reasons, and the first one is not
   * cosmetic: settlement validates its input as a clean six-decimal amount,
   * and a summed float of per-turn provider costs is almost never one.
   * `cachedInputUsdPer1M: 0.1` against a realistic token count yields values
   * like 0.005303499999999999, which `sixDecimalAmount` rejects outright —
   * the settlement then throws, gets swallowed above, and the reservation is
   * stranded for good. The column is numeric(10,4), so what comes back from
   * it is always valid. Second, it is the number the user is shown, and
   * charging a month a different one than the run reports is indefensible.
   *
   * Falls back to the accumulator, rounded up into range, only when the row
   * cannot be read — which in practice means a DB error, since cost_usd is
   * NOT NULL DEFAULT 0. That fallback is valid for any amount this engine can
   * produce, but not for arbitrary ones: roundUpToSixDecimals stops yielding
   * a clean six-decimal above roughly 1e4, well past auditMaxCostUsd. Do not
   * reuse it as a general-purpose settlement amount.
   */
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
      // Fall through to the accumulator.
    }
    // Math.max also normalizes the -0 that roundUpToSixDecimals returns for
    // an input of 0 (its `value - EPSILON` goes fractionally negative before
    // the ceil). sixDecimalAmount accepts -0, but handing a negative zero to
    // an accounting API is the kind of thing that reads as a bug forever.
    return Math.max(0, roundUpToSixDecimals(shared.costUsd));
  }

  // Load config (merge injected overrides for test cap tuning)
  const cfg = env();
  const maxToolCalls = deps?.cfg?.auditMaxToolCalls ?? cfg.auditMaxToolCalls;
  const maxWallClockMs = deps?.cfg?.auditMaxWallClockMs ?? cfg.auditMaxWallClockMs;
  // Mutable: a shared run's reservation lowers it below the configured cap
  // once the run's provenance is known (see the reservation read below).
  let maxCostUsd = deps?.cfg?.auditMaxCostUsd ?? cfg.auditMaxCostUsd;
  const maxTokensTotal = deps?.cfg?.auditMaxTokensTotal ?? cfg.auditMaxTokensTotal;
  const encryptionKey =
    deps?.cfg?.llmKeyEncryptionKey !== undefined
      ? deps.cfg.llmKeyEncryptionKey
      : cfg.llmKeyEncryptionKey;

  /**
   * Re-resolves the run's stored grant. Returns null when access is still
   * good (leaving `credential` refreshed for the next turn), or the tag the
   * run must fail with.
   *
   * Called on BOTH sides of every provider call. Before, so a run whose grant
   * was revoked while it was thinking never makes another call on the
   * owner's key. After, because a revocation that lands DURING a call would
   * otherwise be discovered only on the next iteration — which never comes if
   * that call was the final turn, and the run would persist findings produced
   * with access the owner had already withdrawn.
   */
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

  // Assigned once the run row is loaded; the checkpoint above closes over them.
  let userIdForCheckpoint = '';
  let providerForCheckpoint = '';
  let turnCredential: ProviderCredential | null = null;

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
      // #50 Task 7 — the run's own provenance decides which credential it may
      // use. Read from the ROW, never re-derived from the user's current
      // keys: a recipient who adds a personal key mid-run must not have the
      // run silently switch billing owner underneath them, and one whose
      // grant was revoked must not keep running on a resolver that would now
      // answer differently.
      credentialSource: auditRuns.credentialSource,
      sharedGrantId: auditRuns.sharedGrantId,
      // credentialOwnerId is deliberately NOT selected: the grant id already
      // determines the owner, resolveSharedGrantCredential re-verifies owner
      // state per turn, and a column the engine loads but never reads invites
      // a later reader to assume it is being checked.
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
  userIdForCheckpoint = userId;
  providerForCheckpoint = provider;

  // Arm settlement HERE, the moment the run's provenance is known — not at
  // credential resolution twenty lines down. Review finding: the universe
  // guard below returns between those two points, and with the flag still
  // false the `finally` settled nothing, leaving the reservation held by a
  // run that is already terminal — which no status-keyed recovery can ever
  // find. Coverage that depends on a flag set late is coverage by
  // enumeration wearing a different hat; this is the assignment that makes
  // the `finally` mean what it says.
  shared.active = run.credentialSource === 'shared';
  shared.grantId = run.sharedGrantId;

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
  // Step 2: credential resolution (four-case null contract — Phase 22 D-11,
  // extended to endpoint-based providers by #48's resolveCredential — see
  // that module's doc comment for why "no connection row" is the same null)
  // ---------------------------------------------------------------------------

  // #50 Task 7: a shared run resolves ONLY its stored grant. Falling back to
  // resolveCredential here would defeat the whole feature in the worst
  // possible direction — a revoked grant would quietly resolve to whatever
  // key the recipient happens to have now, or to the recipient's own key,
  // changing who pays for a run that was already admitted against someone
  // else's allowance.
  let credential: ProviderCredential;
  if (run.credentialSource === 'shared') {
    // The provenance FK is ON DELETE SET NULL and the row check permits a
    // shared run with both provenance columns NULL — the tombstone left when
    // a grant row is hard-deleted. Falling through to the personal resolver
    // there would do exactly what this design exists to prevent: quietly move
    // the run onto whatever key the recipient has now. `credentialSource` is
    // the discriminator; a shared run with no grant has lost its access.
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

    // The reservation is what was actually withheld from the recipient's
    // monthly allowance, and it is bounded by the configured cap at admission
    // time — so it is normally the SMALLER of the two. Enforcing the
    // configured cap alone would let a run spend more of the owner's month
    // than was ever reserved for it, and settlement would then charge the
    // overage to a month that never agreed to it.
    const reservation = await _getSharedAuditReservation(runId);
    if (reservation === null || reservation.state !== 'reserved') {
      // Fail closed. A shared run always has a live reservation — admission
      // creates the two in one transaction — so its absence means the run and
      // the ledger disagree. Continuing would restore the full configured
      // ceiling and let the run spend against an administrator's key with
      // nothing withheld from anyone's allowance, which is the one outcome
      // the cap exists to make impossible.
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

  // ---------------------------------------------------------------------------
  // Phase 27 D-06: cost_unknown determination.
  //
  // Consult the provider's PRICING table once before the multi-turn loop. When
  // `pricing(model)` returns undefined, the engine flags `cost_unknown=true` on
  // every UPDATE that touches `cost_usd` (the per-turn telemetry UPDATE, the
  // terminal-success UPDATE, and the partial-INVALID_OUTPUT-success UPDATE).
  //
  // Why a single pre-loop lookup (not per-turn): the (provider, model) pair is
  // fixed for the entire run row. The PRICING table is in-process data — there
  // is no I/O cost. A single read keeps the per-turn UPDATE shape minimal and
  // avoids re-reading the same constant N times.
  //
  // SUM-math safety (D-06): when cost_unknown=true, the per-turn provider call
  // already returns costUsd=0 (post-Phase-27 provider behavior); the engine
  // explicitly writes `cost_usd: '0.0000'` on the terminal UPDATE so the
  // llm-keys totalSpentUsd SUM excluding cost_unknown=true rows is consistent
  // with arithmetic-equivalence on the kept rows.
  //
  // Diagnostic stderr (T-24-04-09 / Phase 27 threat T-27-03-03): when the flag
  // flips on, emit ONE safe-metadata-only log so operators know the unpriced
  // path was exercised. The log is gated by `costUnknownLogged` so a multi-turn
  // run never spams. No credential, no err.message — only { runId, model, provider }.
  const priced = _getProvider(provider as LlmProvider).pricing(model);
  const costUnknown: boolean = priced === undefined;
  let costUnknownLogged = false;
  if (costUnknown && !costUnknownLogged) {
    console.error('[audit-engine] cost_unknown set for model:', { runId, model, provider });
    costUnknownLogged = true;
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
      credential,
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

Identify narrative gaps in this universe. For each gap, the structured findings include:
  - category: one of underdeveloped | missing-link | contradiction | timeline-inconsistency | dangling-thread
  - title: short title (1–500 chars)
  - body: rationale and evidence (1–5000 chars)
  - referenced_entry_ids: array of 1–20 entry UUIDs that are relevant
  - confidence: high | medium | low

When you are ready to deliver your complete list of findings, call the \`emit_findings\` tool exactly once with a single argument \`{ "suggestions": [...] }\`. DO NOT emit findings as prose text — only the \`emit_findings\` tool invocation will be accepted.`;

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

    // #50 Task 7: shared access is re-checked before EVERY turn, not just at
    // run start. A grant revoked at 09:00 must not keep spending the owner's
    // key until a multi-turn run finishes at 09:05.
    const preCallTag = await sharedAccessCheckpoint();
    if (preCallTag !== null) {
      await markFailed(runId, preCallTag);
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
        // The checkpoint above refreshed this for a shared run; a personal run
        // keeps the credential resolved once at run start.
        credential: turnCredential ?? credential,
        messages,
        model,
        // Phase 27 D-10/D-12: both tools flow on every turn.
        //   - getEntryBody: real local tool — engine executes it server-side
        //     and feeds tool_result back.
        //   - emit_findings: structured-output mechanism — model "invokes" it
        //     to deliver the final answer; engine NEVER executes it locally,
        //     parses `tool_use.input` via AuditOutputStrictSchema.
        tools: [getEntryBodyTool, emitFindingsTool],
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

    // Phase 27 D-06: when costUnknown is true, pin cost_usd at '0.0000' (the
    // provider already returns 0 in this branch; the explicit overwrite is
    // belt-and-suspenders against any future drift in the provider's
    // unpriced-cost contract). When false, the per-turn cost accumulates as
    // before. costUnknown is set unconditionally on every UPDATE so the
    // boolean column reflects the run's final flag value even if the loop
    // bails out before the terminal UPDATE.
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

    // #50 Task 7: what settlement will charge the owner's month. Mirrors the
    // costUnknown rule the telemetry UPDATE above applies — an unpriced run
    // records 0 rather than a guess, so it must settle at 0 too or the
    // reservation and the run row would disagree about the same run.
    shared.costUsd = costUnknown ? 0 : totalCost;

    // #50 Task 7: post-call checkpoint. Telemetry above has already recorded
    // what this turn cost — the owner's key was used, so the charge is real
    // and is settled either way. What is discarded is the OUTPUT: if access
    // ended while the provider was answering, `result.text` and
    // `result.toolUse` were produced under a grant that no longer exists, so
    // no issue derived from them may be persisted and no further turn may
    // run. Placed before the emit_findings parse for exactly that reason —
    // one line later and the final answer would already be on its way into
    // the issues table.
    const postCallTag = await sharedAccessCheckpoint();
    if (postCallTag !== null) {
      await markFailed(runId, postCallTag);
      return;
    }

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
    // emit_findings branch (Phase 27 D-09/D-10/D-12): the model's invocation
    // of the emit_findings tool IS the final answer. The SDK has already
    // delivered a pre-parsed JSON object inside `tool_use.input`. We hand it
    // down to the final-turn parse-and-persist block below by capturing the
    // input here; the parse block then Zod-validates `emitFindingsInput`
    // against AuditOutputStrictSchema (same invariant Phase 24 BL-02 added —
    // just applied to tool_use.input instead of the prior prose-text path).
    //
    // The engine NEVER executes emit_findings server-side — it's a structured-
    // output trick. If emit_findings appears alongside getEntryBody calls in
    // the same turn, emit_findings takes precedence (model decided it has
    // enough info; we honor the final-answer signal).
    const emitFindingsCall = result.toolUse.find((t) => t.name === 'emit_findings');
    let emitFindingsInput: unknown = undefined;
    if (emitFindingsCall !== undefined) {
      emitFindingsInput = emitFindingsCall.input;
      // Fall through to the final-turn parse path below.
    }

    // -------------------------------------------------------------------------
    // Tool-use branch: dispatch each getEntryBody call and feed back as tool_result.
    // Skipped when emit_findings is present (the model gave its final answer).
    // -------------------------------------------------------------------------
    if (emitFindingsCall === undefined && result.toolUse.length > 0) {
      // Append the assistant's tool-use turn
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result.toolUse) },
      ];

      const toolResults: Msg[] = [];
      for (const toolCall of result.toolUse) {
        if (toolCall.name === 'emit_findings') {
          // Defense-in-depth: should never reach here (the emit_findings
          // branch above catches it). If a future change moves the branch,
          // skip emit_findings here too — it is NEVER server-executed.
          continue;
        }
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
    //
    // Phase 27 D-09/D-10: the engine's final-turn answer comes from
    // emit_findings tool_use.input (a pre-parsed JSON object), NOT from prose
    // text. The prior three-fallback prose-JSON extractor
    // has been DELETED — prose text in the final turn is a contract violation
    // that fails fast with INVALID_OUTPUT (no recovery fallback). The Zod
    // strict-parse via AuditOutputStrictSchema is the boundary check (Phase 24
    // BL-02 invariant) — preserved here, just applied to tool_use.input.
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
      if (emitFindingsCall === undefined) {
        // No emit_findings tool_use in the final turn — contract violation.
        // Throw a synthetic error that the catch block surfaces as
        // INVALID_OUTPUT (per D-10 fail-fast posture). The error message is
        // structured so the diagnostic stderr below can include the safe
        // metadata (block types seen, not the raw text).
        throw new Error('emit_findings tool_use missing in final turn');
      }
      // BL-02 / T-24-04-03: strict-mode parse is the ONLY parse — rejects
      // LLM-smuggled extra fields (e.g., gap_key) at both the envelope and
      // suggestion levels. Now applied to tool_use.input (Phase 27 D-09);
      // the same invariant as before, just on a different source.
      parsed = AuditOutputStrictSchema.parse(emitFindingsInput);
    } catch (parseErr) {
      // DIAGNOSTIC SURFACE — KEEP (post-2026-05-26 hotfix; preserved per
      // Phase 27 plan must_have "diagnostic stderr STAYS"). Updated message
      // distinguishes the new failure mode: "emit_findings tool_use missing"
      // (no tool invocation at all) vs Zod parse failure (input present but
      // shape-invalid). T-24-04-09 forbids persisting raw text to the DB;
      // stderr is the appropriate diagnostic channel. Safe-metadata only:
      // { runId, model, provider, blockTypes } — NEVER the raw text or the
      // tool_use input payload (which could contain smuggled content per
      // Phase 24 BL-02 / T-24-04-04).
      const blockTypes: string[] = result.toolUse.map((t) => `tool_use:${t.name}`);
      if ((result.text ?? '').length > 0) blockTypes.push('text');
      const errMsg =
        parseErr instanceof Error
          ? `${parseErr.constructor.name}: ${parseErr.message}`
          : String(parseErr);
      console.error(
        `[audit-engine] INVALID_OUTPUT run=${runId} parseErr=${errMsg} blockTypes=${JSON.stringify(blockTypes)} model=${model} provider=${provider}`,
      );
      // Zod parse failure or missing emit_findings tool_use
      if (!anyValidSuggestions) {
        await markFailed(runId, ENGINE_ERROR.INVALID_OUTPUT);
      } else {
        // Some suggestions already persisted — succeed with what we have
        shared.outcome = 'succeeded';
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
    shared.outcome = 'succeeded';
    await _db()
      .update(auditRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(auditRuns.id, runId));

    return;
  }

  } catch (err) {
    // #50 Task 7: a personal run that throws is deliberately left 'running'
    // for recoverOrphanAuditRuns to force-fail on the next boot — that
    // behavior is unchanged. A SHARED run cannot afford to wait for a
    // restart that may never come: its reservation would keep one of the
    // recipient's concurrent slots and part of the owner's month held
    // indefinitely, and the recipient would be locked out of every future
    // shared audit with no way to clear it. So it is failed here and settled
    // below at the cost already incurred, which the owner really did pay.
    if (shared.active) await markFailed(runId, ENGINE_ERROR.UNKNOWN);
    throw err;
  } finally {
    // Release the in-flight Set entry at every terminal exit path:
    // succeeded, budget_exhausted, provider_error, invalid_output, unknown, or re-throw.
    // Any run still in-flight at SIGTERM expiry becomes a process_restarted orphan
    // on next boot via recoverOrphanAuditRuns (AUDIT-12).
    //
    // Ordered BEFORE settlement deliberately: settlement takes FOR UPDATE
    // locks on the recipient's account and usage rows, and if it blocks, a run
    // still in the in-flight set holds the SIGTERM drain open for its whole
    // grace window. The engine's work is done by this point either way.
    releaseRun(runId);

    // #50 Task 7 — settle unconditionally: `finally` covers success, every
    // markFailed path, the early returns after the run row loads, and the
    // re-throw above, so no exit can strand the reservation. A no-op for
    // personal runs, and idempotent for shared ones.
    await settleSharedRun();
  }
}
