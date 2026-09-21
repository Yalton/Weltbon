/**
 *
 * Provides:
 *   POST /audit          — trigger an audit run (202 + concurrent-409 + opt-in-403)
 *   GET  /audits/:runId  — poll audit run state + telemetry + derived suggestion count
 *
 * Both routes mount under /api/universes/:uid (see api/src/index.ts).
 *
 * Security surface:
 *   T-24-05-01 — opt-in enforcement: universe.auditEnabled MUST be true, else 403
 *   T-24-05-02 — cross-universe IDOR: requireUniverse INLINE per handler
 *   T-24-05-03 — cross-universe runId: GET checks auditRun.universeId === uid
 *   T-24-05-04 — gap_key smuggling: strict() Zod body rejects extra fields
 *   T-24-05-09 — unawaited promise rejection: .catch net attached
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, inArray, count, desc } from 'drizzle-orm';
import { isUniqueViolation } from '../db/pg-error.js';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { auditRuns, issues, entries, universes } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { runAudit } from '../services/audit-engine.js';
import { PROVIDER_NAMES, type LlmProvider } from '../services/llm-key.js';
import {
  resolveCredential,
  resolveEffectiveCredential,
  isEndpointProvider,
  type EffectiveLlmCredential,
} from '../services/llm-credential.js';
import {
  getSharedQuotaSnapshot,
  reserveSharedAudit,
  roundUpToSixDecimals,
  SharedLlmError,
  type SharedProvider,
} from '../services/llm-sharing.js';
import { estimateAudit } from '../services/audit-estimator.js';
import type { ProviderCredential } from '../providers/llm/interface.js';
import type { AuditEstimate } from '../types/audit-suggestion.js';
import { env } from '../config.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };


const uidParams = z.object({ uid: z.string().uuid() });
const uidAndRunIdParams = z.object({ uid: z.string().uuid(), runId: z.string().uuid() });


const auditTriggerBody = z
  .object({
    scope: z.enum(['universe', 'entry']),
    entryId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.scope !== 'entry' || v.entryId !== undefined, {
    message: 'entryId is required when scope=entry',
  });

const auditEstimateSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  estCostUsd: z.number().nonnegative(),
});

const auditTriggerResponseSchema = z.object({
  runId: z.string().uuid(),
  estimate: auditEstimateSchema,
});

// Mirrors api/src/types/audit-suggestion.ts AuditEstimate. Independent of any
// existing run (dialog opens BEFORE a run exists; W-1 deviation from CONTEXT

const auditEstimateBreakdownSchema = z.object({
  basePromptTokens: z.number().int().nonnegative(),
  ratePerMTokIn: z.number().nonnegative(),
  ratePerMTokOut: z.number().nonnegative(),
  ratePerMTokCachedRead: z.number().nonnegative(),
  maxToolCalls: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  perCallInputTokens: z.number().int().nonnegative(),
  perCallOutputTokens: z.number().int().nonnegative(),
  minOutputTokens: z.number().int().nonnegative(),
  scopeEntryCount: z.number().int().nonnegative(),
});

const auditEstimateResponseSchema = z.object({
  lower: z.number().nonnegative(),
  upper: z.number().nonnegative(),
  breakdown: auditEstimateBreakdownSchema,
  model: z.object({
    provider: z.enum(PROVIDER_NAMES),
    name: z.string(),
  }),
});

const auditEstimateQuerySchema = z
  .object({
    scope: z.enum(['universe', 'entry']),
    entryId: z.string().uuid().optional(),
    provider: z.enum(PROVIDER_NAMES).optional(),
    model: z.string().optional(),
  })
  .strict()
  .refine((v) => v.scope !== 'entry' || v.entryId !== undefined, {
    message: 'entryId is required when scope=entry',
  });

const auditRunStateSchema = z.object({
  id: z.string().uuid(),
  universeId: z.string().uuid(),
  userId: z.string().uuid(),
  scope: z.string(),
  scopeEntryId: z.string().uuid().nullable(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  cachedTokens: z.number().int(),
  toolCallCount: z.number().int(),
  costUsd: z.string(), // NUMERIC(10,4) comes back as string from pg
  // 27-03 shipped (only auditHistoryRowSchema did); the banner reads
  // renders. Documented as a Rule 2 deviation in 27-04-SUMMARY.md.
  costUnknown: z.boolean(),
  triggerSource: z.string(),
  error: z.string().nullable(),
  startedAt: z.string().or(z.date()),
  finishedAt: z.string().or(z.date()).nullable(),
  gapKeyCollisionCount: z.number().int(),
  hallucinatedEntryReferenceCount: z.number().int(),
  suggestionCount: z.number().int(),
  // the shared-provenance triple that crosses the wire: `credential_owner_id`
  credentialSource: z.enum(['own', 'shared']),
});

// optional so the shared-credential failures (which the recipient UI has to
// branch on — consent vs. quota vs. owner-side outage all need different
// forcing callers to string-match on prose that is free to be reworded.
const errorSchema = z.object({ error: z.string(), code: z.string().optional() });


const auditHistoryRowSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(['universe', 'entry']),
  scopeEntryId: z.string().uuid().nullable(),
  scopeEntryTitle: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  costUsd: z.string(),
  costUnknown: z.boolean(),
  startedAt: z.string().or(z.date()),
  finishedAt: z.string().or(z.date()).nullable(),
  // Categories with zero counts are omitted; null-category issues are excluded.
  // Keys are AuditCategory values (validated app-side); typed as string at the
  suggestionsByCategory: z.record(z.string(), z.number().int()),
  analyzedEntries: z.number().int(),
  // null for entry-scoped runs (per AuditHistoryRow JSDoc)
  totalEntries: z.number().int().nullable(),
  // the shared-provenance triple that crosses the wire: `credential_owner_id`
  credentialSource: z.enum(['own', 'shared']),
});

const auditHistoryResponseSchema = z.object({
  rows: z.array(auditHistoryRowSchema),
  total: z.number().int(),
  hasMore: z.boolean(),
});

const auditHistoryQuerySchema = z.object({
  // T-26-03-03: bounded limit (max 200) prevents unbounded-scan DoS
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// Both audit-trigger surfaces (POST /audit and GET /audits/estimate) have to
// answer the same question — "which credential may this caller run on, and if


// response-declaration check. That cast silenced the check entirely — deleting
type SharedFailure<S extends 403 | 409 | 422 | 429 | 503> = {
  status: S;
  body: { error: string; code: string };
};

const SHARED_CONSENT_REQUIRED: SharedFailure<403> = {
  status: 403,
  body: {
    error: 'Shared connection requires consent before use',
    code: 'shared_llm_consent_required',
  },
};

// Owner-side state (administrator disabled or demoted, key deleted or
// llm-credential.ts forbids console output by design. An operator debugging
const SHARED_CREDENTIAL_UNAVAILABLE: SharedFailure<503> = {
  status: 503,
  body: {
    error: 'Shared connection is temporarily unavailable',
    code: 'shared_credential_unavailable',
  },
};

const SHARED_COST_UNAVAILABLE: SharedFailure<422> = {
  status: 422,
  body: {
    error: 'This model has no published price, so a shared run cannot be capped',
    code: 'shared_cost_unavailable',
  },
};

const SHARED_LIMIT_EXCEEDED: SharedFailure<429> = {
  status: 429,
  body: {
    error: 'Shared monthly allowance is exhausted',
    code: 'shared_monthly_limit_exceeded',
  },
};

const SHARED_AUDIT_IN_PROGRESS: SharedFailure<409> = {
  status: 409,
  body: {
    // Recipient-scoped, not universe-scoped: the cap is one concurrent shared
    error: 'A shared audit is already running for your account',
    code: 'shared_audit_in_progress',
  },
};

const SHARED_ACCESS_REVOKED: SharedFailure<403> = {
  status: 403,
  body: { error: 'Shared access is no longer available', code: 'shared_access_revoked' },
};

type SharedAdmissionFailure =
  | SharedFailure<403>
  | SharedFailure<409>
  | SharedFailure<422>
  | SharedFailure<429>
  | SharedFailure<503>;

function sharedAdmissionFailure(error: unknown): SharedAdmissionFailure | null {
  if (!(error instanceof SharedLlmError)) return null;
  switch (error.code) {
    case 'shared_audit_in_progress':
      return SHARED_AUDIT_IN_PROGRESS;
    case 'shared_monthly_limit_exceeded':
      return SHARED_LIMIT_EXCEEDED;
    case 'shared_cost_invalid':
      return SHARED_COST_UNAVAILABLE;
    case 'shared_llm_consent_required':
      return SHARED_CONSENT_REQUIRED;
    case 'shared_access_revoked':
      return SHARED_ACCESS_REVOKED;
    default:
      return SHARED_CREDENTIAL_UNAVAILABLE;
  }
}

type RunCredential =
  | { kind: 'ready'; credential: ProviderCredential; effective: EffectiveLlmCredential | null }
  | { kind: 'none' }
  // owner credential is unusable, never for quota reasons.
  | { kind: 'failure'; failure: SharedFailure<403> | SharedFailure<503> };

/**
 * Resolves the credential an audit on `provider` would actually run on.
 *
 * `effective` is null for endpoint providers (ollama), which have no shared
 * surface at all and keep the pre-#50 `resolveCredential` path verbatim.
 *
 * Two pre-#50 behaviors are preserved deliberately rather than upgraded to a
 * shared-style error:
 *   - no own key and no grant → 'none', because both callers already have a
 *     considered answer for "nothing to run on" (trigger: create the row
 *     anyway and let the engine record the real failure; estimate: 400 with
 *     provider-specific copy pointing at the right settings screen).
 *   - own row present but undecryptable → also 'none'. It must NOT fall
 *     through to a grant: silently moving a run onto an administrator's
 *     credential because the user's own key broke changes who pays without
 *     anyone asking. `resolveEffectiveCredential` already fails closed here;
 *     this keeps the route's observable behavior identical to before #50.
 */
async function resolveRunCredential(
  userId: string,
  provider: LlmProvider,
  encryptionKeyHex: string | undefined,
): Promise<RunCredential> {
  if (isEndpointProvider(provider)) {
    const credential = await resolveCredential(userId, provider, encryptionKeyHex);
    return credential ? { kind: 'ready', credential, effective: null } : { kind: 'none' };
  }

  const resolved = await resolveEffectiveCredential(userId, provider, encryptionKeyHex);
  switch (resolved.kind) {
    case 'ready':
      return { kind: 'ready', credential: resolved.value.credential, effective: resolved.value };
    case 'consent_required':
      return { kind: 'failure', failure: SHARED_CONSENT_REQUIRED };
    case 'unavailable':
      return resolved.source === 'shared'
        ? { kind: 'failure', failure: SHARED_CREDENTIAL_UNAVAILABLE }
        : { kind: 'none' };
    case 'missing':
      return { kind: 'none' };
  }
}

/**
 * Refuses a shared caller who cannot be admitted no matter what the estimate
 * says, BEFORE the estimator runs.
 *
 * and `estimateAudit` calls the provider on the OWNER's credential (for
 * Anthropic, a live `messages.countTokens`). A recipient whose monthly cap was
 * already exhausted therefore got a 429 — after three requests had made three
 * calls against the administrator's account. countTokens is zero-billed, so
 * that is not spend, but it is an unmetered proxy into the owner's rate limit
 * driven by a party the server has already refused.
 *
 * This is NOT a second copy of the admission rule. It only ever REJECTS, and
 * only on state that cannot improve within the request: `reserveSharedAudit`
 * re-reads everything under its locks and stays the only thing that admits a
 * run. Anything this lets through is still decided there.
 *
 * The cap comparison inherits `getSharedQuotaSnapshot`'s four-decimal
 * rounding (`money()` in llm-sharing.ts) while the reservation compares raw
 * numeric(12,6), so near the boundary this can refuse a recipient whose true
 * remaining allowance is under $0.00005. That direction is deliberate: erring
 * toward not spending an administrator's budget is the safe failure for this
 * feature, and no real audit estimate is that small.
 */
async function sharedPreflightFailure(
  userId: string,
): Promise<SharedFailure<409> | SharedFailure<429> | null> {
  const quota = await getSharedQuotaSnapshot(userId);
  if (quota.activeAudits >= quota.maxConcurrentAudits) return SHARED_AUDIT_IN_PROGRESS;
  if (Number(quota.settledUsd) + Number(quota.reservedUsd) >= Number(quota.limitUsd)) {
    return SHARED_LIMIT_EXCEEDED;
  }
  return null;
}


const triggerAuditRoute = createRoute({
  method: 'post',
  path: '/audit',
  tags: ['Audits'],
  summary: 'Trigger an audit run for a universe',
  description:
    'Creates an audit_runs row with status=pending and fires the audit engine ' +
    'as a fire-and-forget process. Returns 202 with the runId and a pre-run estimate. ' +
    'Returns 409 if a run is already in progress. Returns 403 if auditing is not enabled.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: {
      content: {
        'application/json': {
          schema: auditTriggerBody,
        },
      },
      required: true,
    },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: auditTriggerResponseSchema } },
      description: 'Audit run started',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    403: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Audit not enabled for this universe or cross-tenant access',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'An audit is already in progress for this universe, or (shared credential) ' +
        'for this recipient across all universes (shared_audit_in_progress).',
    },
    422: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Shared credential only: the configured model has no published price, so the run ' +
        'cannot be bounded against the monthly cap (shared_cost_unavailable).',
    },
    429: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Shared credential only: the reservation does not fit the remaining monthly ' +
        'allowance (shared_monthly_limit_exceeded).',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
    502: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Shared credential only: the pre-run estimate failed, so no reservation amount ' +
        'could be computed (estimate_unavailable).',
    },
    503: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Shared credential only: the owner credential is currently unusable ' +
        '(shared_credential_unavailable).',
    },
  },
});

const listAuditHistoryRoute = createRoute({
  method: 'get',
  path: '/audits',
  tags: ['Audits'],
  summary: 'List past audit runs for a universe (paginated)',
  description:
    'D-09 audit history powering the AuditHistoryTable tab inside UniverseSettings ' +
    'Returns rows ordered by startedAt DESC. Aggregates ' +
    'suggestionsByCategory from the issues table (GROUP BY category) in a single batched ' +
    'query. T-24-05-02 requireUniverse fires inline; cross-tenant access → 403. ' +
    'Empty universe returns `{ rows:[], total:0, hasMore:false }`, NOT 404.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    query: auditHistoryQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: auditHistoryResponseSchema } },
      description: 'Paginated audit-run history',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error (e.g. limit > 200)',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    403: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Cross-tenant access',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// existing run (dialog opens BEFORE a run exists; W-1 deviation from CONTEXT

const getAuditEstimateRoute = createRoute({
  method: 'get',
  path: '/audits/estimate',
  tags: ['Audits'],
  summary: 'Pre-run cost-range estimate for a planned audit',
  description:
    'LLMUI-04 cost-range estimate computed by services/audit-estimator.ts. ' +
    'requireUniverse fires inline (T-24-05-02). audit_enabled=false → 403 ' +
    '(every audit-trigger surface honors the opt-in setting, ' +
    'even though estimate is purely informational). On estimator failure ' +
    'returns 502 with generic copy (T-26-08-02 — never leak provider stack).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    query: auditEstimateQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: auditEstimateResponseSchema } },
      description: 'AuditEstimate (lower/upper USD + breakdown + model)',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error or no API key configured for provider',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    403: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Audit not enabled for this universe or cross-tenant access',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Shared credential only: the recipient already has a shared audit running, so no ' +
        'estimate is worth computing against the owner credential (shared_audit_in_progress).',
    },
    422: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Shared credential only: the requested model has no published price, so a shared ' +
        'run cannot be bounded against the monthly cap (shared_cost_unavailable).',
    },
    429: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Shared credential only: the bounded reservation exceeds the remaining monthly ' +
        'allowance (shared_monthly_limit_exceeded). Returned by the estimate so the ' +
        'dialog can say so before the user commits to a run.',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
    502: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Estimator failed to compute cost (provider outage / token-count failure)',
    },
    503: {
      content: { 'application/json': { schema: errorSchema } },
      description:
        'Shared credential only: the owner credential is currently unusable ' +
        '(shared_credential_unavailable).',
    },
  },
});

const getAuditRoute = createRoute({
  method: 'get',
  path: '/audits/{runId}',
  tags: ['Audits'],
  summary: 'Get audit run state + telemetry',
  description:
    'Returns the current state of an audit run including token telemetry and ' +
    'suggestionCount derived from COUNT(*) FROM issues WHERE audit_run_id = :runId (D-02).',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndRunIdParams,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: auditRunStateSchema } },
      description: 'Audit run state',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    403: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Cross-tenant or cross-universe access',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe or run not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});


export const auditRoutes = new OpenAPIHono<AppEnv>()

  .openapi(triggerAuditRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const userId = c.var.userId;
    const body = c.req.valid('json');

    // T-24-05-02: requireUniverse INLINE (not middleware — Hono middleware runs before param validation)
    const universe = await requireUniverse(uid, userId);

    // T-24-05-01: server-side opt-in enforcement — never decorative UI toggle
    if (!universe.auditEnabled) {
      throw new HTTPException(403, { message: 'Audit not enabled for this universe' });
    }

    // Validate scope=entry → entryId belongs to this universe (cross-universe scopeEntryId guard)
    if (body.scope === 'entry' && body.entryId) {
      const [entryRow] = await db()
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, body.entryId), eq(entries.universeId, uid)))
        .limit(1);
      if (!entryRow) {
        throw new HTTPException(403, { message: 'Entry not found in this universe' });
      }
    }

    // T-24-05-07: Concurrent-run 409 pre-check (pre-check SELECT + 23505 catch pattern)
    const existing = await db()
      .select({ id: auditRuns.id })
      .from(auditRuns)
      .where(
        and(
          eq(auditRuns.universeId, uid),
          inArray(auditRuns.status, ['pending', 'running'])
        )
      )
      .limit(1);
    if (existing.length > 0) {
      return c.json({ error: 'An audit is already in progress for this universe' }, 409);
    }

    // union test (llm-provider-union.test.ts) anyway — same file, same
    // stale two-provider literal. universe.auditProvider is DB free text
    // (not Zod-validated at read time), so this cast is the only place the
    const provider = universe.auditProvider as LlmProvider;
    const model = universe.auditModel!;
    const cfg = env();

    const resolved = await resolveRunCredential(userId, provider, cfg.llmKeyEncryptionKey);
    if (resolved.kind === 'failure') {
      return c.json(resolved.failure.body, resolved.failure.status);
    }
    const credential = resolved.kind === 'ready' ? resolved.credential : null;
    const effective = resolved.kind === 'ready' ? resolved.effective : null;

    // Refuse an already-exhausted or already-busy shared caller before the
    // estimator touches the owner's credential — see sharedPreflightFailure.
    if (effective?.source === 'shared') {
      const preflight = await sharedPreflightFailure(userId);
      if (preflight) return c.json(preflight.body, preflight.status);
    }

    // REPLACED with a call to estimateAudit() (services/audit-estimator.ts) —
    // For an own-credential run this stays best-effort: failure must NOT block
    // run it is load-bearing — the estimate's upper bound is the reservation
    let estimate: { promptTokens: number; estCostUsd: number } = { promptTokens: 0, estCostUsd: 0 };
    let estimateResult: AuditEstimate | null = null;
    if (credential) {
      try {
        estimateResult = await estimateAudit({
          universeId: uid,
          scope: body.scope,
          entryId: body.entryId,
          provider,
          model,
          credential,
          userId,
        });
        // input-tokens-only point estimate semantics most closely).
        estimate = {
          promptTokens: estimateResult.breakdown.basePromptTokens,
          estCostUsd: estimateResult.lower,
        };
      } catch {
        // Estimate failure must NOT block an own-credential run — see above.
        estimateResult = null;
      }
    }

    if (effective?.source === 'shared') {
      if (!estimateResult) {
        return c.json(
          { error: 'Could not estimate run cost', code: 'estimate_unavailable' },
          502,
        );
      }
      if (estimateResult.upper <= 0) {
        // PRICING (its Step 2 miss). An own-key run may proceed unpriced —
        // `upper <= 0` is the PRICING-miss signal, not an arbitrary threshold:
        // zeroed miss can reach 0. A future zero-priced or free-tier entry
        return c.json(SHARED_COST_UNAVAILABLE.body, SHARED_COST_UNAVAILABLE.status);
      }
      try {
        const reserved = await reserveSharedAudit({
          recipientUserId: userId,
          universeId: uid,
          scope: body.scope,
          scopeEntryId: body.entryId ?? null,
          // SharedProvider (llm-credential.ts refuses every other provider
          provider: provider as SharedProvider,
          model,
          grantId: effective.sharedGrantId!,
          credentialOwnerId: effective.credentialOwnerId,
          // Reserve the UPPER bound, clamped by the per-run ceiling the engine
          // legitimately lands mid-range overshoot the monthly cap, and
          reservationUsd: roundUpToSixDecimals(
            Math.min(estimateResult.upper, cfg.auditMaxCostUsd),
          ),
        });

        // Fire-and-forget engine — T-24-05-09: .catch net prevents unhandled rejections
        queueMicrotask(() => {
          runAudit(reserved.runId).catch((err) => console.error('[audit] runAudit failed:', err));
        });

        return c.json({ runId: reserved.runId, estimate }, 202);
      } catch (e: unknown) {
        const failure = sharedAdmissionFailure(e);
        if (failure) return c.json(failure.body, failure.status);
        throw e;
      }
    }

    let runId: string;
    try {
      const [{ id }] = await db()
        .insert(auditRuns)
        .values({
          universeId: uid,
          userId,
          scope: body.scope,
          scopeEntryId: body.entryId ?? null,
          provider: universe.auditProvider!,
          model: universe.auditModel!,
          status: 'pending',
          triggerSource: 'manual',
          credentialSource: 'own',
          credentialOwnerId: userId,
          sharedGrantId: null,
        })
        .returning({ id: auditRuns.id });
      runId = id;
    } catch (e: unknown) {
      // concurrent POSTs both pass the pre-check SELECT and both attempt INSERT. The partial
      // is what makes this branch live: without it, both INSERTs would succeed and AUDIT-10's
      // "a parallel-audit attempt returns HTTP 409" guarantee would be violated.
      if (isUniqueViolation(e)) {
        return c.json({ error: 'An audit is already in progress for this universe' }, 409);
      }
      throw e;
    }

    // Fire-and-forget engine — T-24-05-09: .catch net prevents unhandled rejections
    queueMicrotask(() => {
      runAudit(runId).catch((err) => console.error('[audit] runAudit failed:', err));
    });

    return c.json({ runId, estimate }, 202);
  })

  .openapi(listAuditHistoryRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const { limit, offset } = c.req.valid('query');
    const userId = c.var.userId;

    // T-26-03-04 / T-24-05-02: requireUniverse INLINE.
    await requireUniverse(uid, userId);

    // Base universe-scoped page: ORDER BY started_at DESC LIMIT ?n OFFSET ?n
    const rows = await db()
      .select({
        id: auditRuns.id,
        scope: auditRuns.scope,
        scopeEntryId: auditRuns.scopeEntryId,
        scopeEntryTitle: entries.title,
        provider: auditRuns.provider,
        model: auditRuns.model,
        status: auditRuns.status,
        costUsd: auditRuns.costUsd,
        costUnknown: auditRuns.costUnknown,
        startedAt: auditRuns.startedAt,
        finishedAt: auditRuns.finishedAt,
        analyzedEntries: auditRuns.analyzedEntries,
        credentialSource: auditRuns.credentialSource,
      })
      .from(auditRuns)
      .leftJoin(entries, eq(entries.id, auditRuns.scopeEntryId))
      .where(eq(auditRuns.universeId, uid))
      .orderBy(desc(auditRuns.startedAt))
      .limit(limit)
      .offset(offset);

    const [{ count: totalCount }] = await db()
      .select({ count: count() })
      .from(auditRuns)
      .where(eq(auditRuns.universeId, uid));
    const total = Number(totalCount);

    // T-26-03-02: suggestionsByCategory aggregation. Single batched query keyed
    // by audit_run_id IN (:runIdsForThisPage); runIds came from the universe-
    // filtered base query above so cross-universe leak is impossible. Excludes
    // null-category issues (human-source) via IS NOT NULL.
    const runIds = rows.map((r) => r.id);
    const byCategoryRows: Array<{ auditRunId: string; category: string; cnt: number }> =
      runIds.length === 0
        ? []
        : (
            await db()
              .select({
                auditRunId: issues.auditRunId,
                category: issues.category,
                cnt: count(),
              })
              .from(issues)
              .where(inArray(issues.auditRunId, runIds))
              .groupBy(issues.auditRunId, issues.category)
          )
            // Filter out null-category in app code (Drizzle's isNotNull import path
            // wasn't already imported; group-by then app-side filter is functionally
            .filter((r) => r.category !== null)
            .map((r) => ({
              auditRunId: r.auditRunId as string,
              category: r.category as string,
              cnt: Number(r.cnt),
            }));

    const byRunCategory = new Map<string, Record<string, number>>();
    for (const r of byCategoryRows) {
      const bucket = byRunCategory.get(r.auditRunId) ?? {};
      bucket[r.category] = r.cnt;
      byRunCategory.set(r.auditRunId, bucket);
    }

    // applied to universe-scoped rows only. Entry-scoped rows get null
    const [{ count: totalEntriesCount }] = await db()
      .select({ count: count() })
      .from(entries)
      .where(eq(entries.universeId, uid));
    const universeTotalEntries = Number(totalEntriesCount);

    const responseRows = rows.map((r) => ({
      id: r.id,
      scope: r.scope as 'universe' | 'entry',
      scopeEntryId: r.scopeEntryId,
      scopeEntryTitle: r.scopeEntryTitle, // null when scope='universe' (no JOIN match)
      provider: r.provider,
      model: r.model,
      status: r.status as 'pending' | 'running' | 'succeeded' | 'failed',
      costUsd: r.costUsd, // string from NUMERIC(10,4)
      costUnknown: r.costUnknown,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      suggestionsByCategory: byRunCategory.get(r.id) ?? {},
      analyzedEntries: r.analyzedEntries,
      totalEntries: r.scope === 'entry' ? null : universeTotalEntries,
      credentialSource: r.credentialSource,
    }));

    return c.json(
      {
        rows: responseRows,
        total,
        hasMore: offset + responseRows.length < total,
      },
      200,
    );
  })

  .openapi(getAuditEstimateRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const query = c.req.valid('query');
    const userId = c.var.userId;

    // T-24-05-02: requireUniverse INLINE
    const universe = await requireUniverse(uid, userId);

    // T-26-08-01: opt-in invariant preserved across the audit-trigger family.
    // Estimate is purely informational but the audit-trigger surface MUST NOT
    if (!universe.auditEnabled) {
      throw new HTTPException(403, { message: 'Audit not enabled for this universe' });
    }

    const provider = (query.provider ?? universe.auditProvider) as LlmProvider | null;
    const model = query.model ?? universe.auditModel;
    if (!provider || !model) {
      return c.json(
        { error: 'No provider/model configured for this universe' },
        400,
      );
    }

    // Resolve the user's credential for this provider — a decrypted API key
    // endpoint-based one.
    // KEY_PROVIDER_NAMES excludes it and llm-keys.ts is the only INSERT into
    // every request for an Ollama universe, and that 400 is load-bearing on
    // place the key table and the connection table meet (spec D-3).
    // The consent and owner-unusable refusals land here rather than after the
    // provider would be a use of the owner's credential, and consent is
    const cfg = env();
    const resolved = await resolveRunCredential(userId, provider, cfg.llmKeyEncryptionKey);
    if (resolved.kind === 'failure') {
      return c.json(resolved.failure.body, resolved.failure.status);
    }
    if (resolved.kind === 'none') {
      return c.json(
        {
          error: isEndpointProvider(provider)
            ? `No ${provider} connection configured — add a server address in Settings`
            : `No API key configured for ${provider}`,
        },
        400,
      );
    }
    const { credential, effective } = resolved;

    // Same pre-estimator refusal the trigger applies: a recipient who is over
    // concurrency gate the post-estimate preview below does not.
    if (effective?.source === 'shared') {
      const preflight = await sharedPreflightFailure(userId);
      if (preflight) return c.json(preflight.body, preflight.status);
    }

    // T-26-08-02: wrap the estimator in try/catch — provider failure surfaces
    let result: AuditEstimate;
    try {
      result = await estimateAudit({
        universeId: uid,
        scope: query.scope,
        entryId: query.entryId,
        provider,
        model,
        credential,
        userId,
      });
    } catch {
      return c.json({ error: 'Could not estimate run cost' }, 502);
    }

    // does not fit. Answering 200 with a cost range and then 429-ing the
    // re-checks under its locks and remains the only thing that admits a run.
    // It also inherits the snapshot's four-decimal rounding while the
    if (effective?.source === 'shared') {
      if (result.upper <= 0) {
        return c.json(SHARED_COST_UNAVAILABLE.body, SHARED_COST_UNAVAILABLE.status);
      }
      const reservationUsd = roundUpToSixDecimals(Math.min(result.upper, cfg.auditMaxCostUsd));
      const quota = await getSharedQuotaSnapshot(userId);
      const committed = Number(quota.settledUsd) + Number(quota.reservedUsd);
      if (committed + reservationUsd > Number(quota.limitUsd)) {
        return c.json(SHARED_LIMIT_EXCEEDED.body, SHARED_LIMIT_EXCEEDED.status);
      }
    }

    return c.json(result, 200);
  })

  .openapi(getAuditRoute, async (c) => {
    const { uid, runId } = c.req.valid('param');
    const userId = c.var.userId;

    // T-24-05-02: requireUniverse INLINE
    await requireUniverse(uid, userId);

    // Fetch the run — T-24-05-03: filter by universeId to prevent cross-universe runId
    const [run] = await db()
      .select()
      .from(auditRuns)
      .where(and(eq(auditRuns.id, runId), eq(auditRuns.universeId, uid)))
      .limit(1);

    if (!run) {
      throw new HTTPException(404, { message: 'Audit run not found' });
    }

    // D-02: derive suggestionCount from COUNT(*) — single source of truth, no separate counter
    const [{ count: suggestionCount }] = await db()
      .select({ count: count() })
      .from(issues)
      .where(eq(issues.auditRunId, runId));

    return c.json(
      {
        id: run.id,
        universeId: run.universeId,
        userId: run.userId,
        scope: run.scope,
        scopeEntryId: run.scopeEntryId,
        provider: run.provider,
        model: run.model,
        status: run.status as 'pending' | 'running' | 'succeeded' | 'failed',
        promptTokens: run.promptTokens,
        completionTokens: run.completionTokens,
        cachedTokens: run.cachedTokens,
        toolCallCount: run.toolCallCount,
        costUsd: run.costUsd,
        costUnknown: run.costUnknown,
        triggerSource: run.triggerSource,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        gapKeyCollisionCount: run.gapKeyCollisionCount,
        hallucinatedEntryReferenceCount: run.hallucinatedEntryReferenceCount,
        suggestionCount: Number(suggestionCount),
        credentialSource: run.credentialSource,
      },
      200
    );
  });

// ─── Cross-universe audit routes ─────────────────────────────────────────────
// the only authorization filter is the `audit_runs.user_id = c.var.userId`
// predicate in the handler (T-26-03-01).
// Full path: /api/audits/in-flight

const inFlightSummarySchema = z.object({
  id: z.string().uuid(),
  universeId: z.string().uuid(),
  universeName: z.string(),
  scope: z.enum(['universe', 'entry']),
  scopeEntryId: z.string().uuid().nullable(),
  scopeEntryTitle: z.string().nullable(),
  status: z.enum(['pending', 'running']),
  startedAt: z.string().or(z.date()),
  costUsd: z.string(),
  toolCallCount: z.number().int(),
});

const inFlightArraySchema = z.array(inFlightSummarySchema);

const getInFlightAuditsRoute = createRoute({
  method: 'get',
  path: '/in-flight',
  tags: ['Audits'],
  summary: "List the authed user's in-flight audit runs across all universes",
  description:
    'Cross-universe rollup powering the in-flight audit badge. ' +
    'Returns audit_runs rows with status IN (\'pending\',\'running\') filtered by user_id. ' +
    'NO requireUniverse fires — this is a user-scoped endpoint. Ordering: startedAt DESC. ' +
    'Empty result is `[]`, NOT 404.',
  security: [{ bearerAuth: [] }],
  request: {
    // No params — auth derives userId from bearer token
  },
  responses: {
    200: {
      content: { 'application/json': { schema: inFlightArraySchema } },
      description: "Array of the user's pending+running audit runs (possibly empty)",
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

export const auditCrossUniverseRoutes = new OpenAPIHono<AppEnv>()

  // GET /api/audits/in-flight
  .openapi(getInFlightAuditsRoute, async (c) => {
    const userId = c.var.userId;

    // T-26-03-01: filter strictly by user_id; cross-tenant invariant.
    const rows = await db()
      .select({
        id: auditRuns.id,
        universeId: auditRuns.universeId,
        universeName: universes.name,
        scope: auditRuns.scope,
        scopeEntryId: auditRuns.scopeEntryId,
        scopeEntryTitle: entries.title,
        status: auditRuns.status,
        startedAt: auditRuns.startedAt,
        costUsd: auditRuns.costUsd,
        toolCallCount: auditRuns.toolCallCount,
      })
      .from(auditRuns)
      .leftJoin(universes, eq(universes.id, auditRuns.universeId))
      .leftJoin(entries, eq(entries.id, auditRuns.scopeEntryId))
      .where(
        and(
          eq(auditRuns.userId, userId),
          inArray(auditRuns.status, ['pending', 'running']),
        ),
      )
      .orderBy(desc(auditRuns.startedAt));

    const body = rows.map((r) => ({
      id: r.id,
      universeId: r.universeId,
      // universeName is non-null in practice (universes row exists via FK cascade)
      // but the LEFT JOIN typing makes it nullable — defensive empty-string fallback.
      universeName: r.universeName ?? '',
      scope: r.scope as 'universe' | 'entry',
      scopeEntryId: r.scopeEntryId,
      scopeEntryTitle: r.scopeEntryTitle, // null for scope='universe' (no JOIN match)
      status: r.status as 'pending' | 'running',
      startedAt: r.startedAt,
      costUsd: r.costUsd, // string from NUMERIC(10,4)
      toolCallCount: r.toolCallCount,
    }));

    return c.json(body, 200);
  });
