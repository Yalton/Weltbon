/**
 * Phase 24 Plan 05 — audit routes.
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

// ─── Path param schemas ──────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndRunIdParams = z.object({ uid: z.string().uuid(), runId: z.string().uuid() });

// ─── Request/response schemas ────────────────────────────────────────────────

/**
 * T-24-05-04: .strict() rejects extra fields — gap_key smuggling defense.
 * The route layer NEVER accepts gap_key in any request body.
 */
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

// Phase 26 Plan 08 Task 1 — AuditEstimate wire shape for GET /audits/estimate.
// Mirrors api/src/types/audit-suggestion.ts AuditEstimate. Independent of any
// existing run (dialog opens BEFORE a run exists; W-1 deviation from CONTEXT
// D-16's runId-in-path hint — see plan body <interfaces> resolution).
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
  // Phase 27 D-06 — true when the run used a model absent from PRICING; the
  // engine pins costUsd to '0.0000' in that branch and AuditCompletionBanner
  // renders the "cost unknown" amber chip instead of "Cost: $0.0000".
  // Plan 04 Rule 2: the single-run wire shape did not expose this field when
  // 27-03 shipped (only auditHistoryRowSchema did); the banner reads
  // useAuditRun() so the field has to surface here as well or the chip never
  // renders. Documented as a Rule 2 deviation in 27-04-SUMMARY.md.
  costUnknown: z.boolean(),
  triggerSource: z.string(),
  error: z.string().nullable(),
  startedAt: z.string().or(z.date()),
  finishedAt: z.string().or(z.date()).nullable(),
  gapKeyCollisionCount: z.number().int(),
  hallucinatedEntryReferenceCount: z.number().int(),
  suggestionCount: z.number().int(),
  // #50 Task 6 — which credential paid for this run. This is the ONLY piece of
  // the shared-provenance triple that crosses the wire: `credential_owner_id`
  // and `shared_grant_id` identify another user and a specific grant row, and
  // a recipient has no use for either. The literal union (not the raw column)
  // also means a future third source cannot leak out of the API until someone
  // widens this deliberately.
  credentialSource: z.enum(['own', 'shared']),
});

// #50 Task 6: every pre-#50 body was `{ error }` and still is. `code` is
// optional so the shared-credential failures (which the recipient UI has to
// branch on — consent vs. quota vs. owner-side outage all need different
// copy and different affordances) can travel in the same envelope instead of
// forcing callers to string-match on prose that is free to be reworded.
const errorSchema = z.object({ error: z.string(), code: z.string().optional() });

// ─── Phase 26 Plan 03 — D-09 audit-history schemas ──────────────────────────

const auditHistoryRowSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(['universe', 'entry']),
  scopeEntryId: z.string().uuid().nullable(),
  scopeEntryTitle: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  // NUMERIC(10,4) → string (string preserves decimal precision)
  costUsd: z.string(),
  // Phase 27 D-06: true when the run used a model absent from PRICING; the
  // engine pins costUsd to '0.0000' in that branch and the UI renders a
  // "cost unknown" chip in place of the dollar amount.
  costUnknown: z.boolean(),
  startedAt: z.string().or(z.date()),
  finishedAt: z.string().or(z.date()).nullable(),
  // Categories with zero counts are omitted; null-category issues are excluded.
  // Keys are AuditCategory values (validated app-side); typed as string at the
  // OpenAPI boundary because z.record() with an enum key requires ALL enum keys
  // present, which conflicts with the Partial<Record<AuditCategory, number>>
  // wire shape (Plan 26-01 AuditHistoryRow).
  suggestionsByCategory: z.record(z.string(), z.number().int()),
  analyzedEntries: z.number().int(),
  // null for entry-scoped runs (per AuditHistoryRow JSDoc)
  totalEntries: z.number().int().nullable(),
  // #50 Task 6 — which credential paid for this run. This is the ONLY piece of
  // the shared-provenance triple that crosses the wire: `credential_owner_id`
  // and `shared_grant_id` identify another user and a specific grant row, and
  // a recipient has no use for either. The literal union (not the raw column)
  // also means a future third source cannot leak out of the API until someone
  // widens this deliberately.
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

// ─── #50 Task 6 — shared-credential admission helpers ────────────────────────
//
// Both audit-trigger surfaces (POST /audit and GET /audits/estimate) have to
// answer the same question — "which credential may this caller run on, and if
// none, why not?" — and give the same answer for the same account state. They
// live here rather than in each handler so the two cannot drift into telling a
// recipient different stories about one grant.

type SharedFailure = {
  status: 403 | 409 | 422 | 429 | 503;
  body: { error: string; code: string };
};

const SHARED_CONSENT_REQUIRED: SharedFailure = {
  status: 403,
  body: {
    error: 'Shared connection requires consent before use',
    code: 'shared_llm_consent_required',
  },
};

// Owner-side state (administrator disabled or demoted, key deleted or
// rotated, ciphertext undecryptable) collapses to one opaque code on purpose:
// each of those describes ANOTHER user's account, and telling a recipient
// which one it is turns an audit button into an oracle for the administrator
// roster. The operator still has the audit log.
const SHARED_CREDENTIAL_UNAVAILABLE: SharedFailure = {
  status: 503,
  body: {
    error: 'Shared connection is temporarily unavailable',
    code: 'shared_credential_unavailable',
  },
};

const SHARED_COST_UNAVAILABLE: SharedFailure = {
  status: 422,
  body: {
    error: 'This model has no published price, so a shared run cannot be capped',
    code: 'shared_cost_unavailable',
  },
};

const SHARED_LIMIT_EXCEEDED: SharedFailure = {
  status: 429,
  body: {
    error: 'Shared monthly allowance is exhausted',
    code: 'shared_monthly_limit_exceeded',
  },
};

/**
 * Maps a `SharedLlmError` thrown by `reserveSharedAudit` onto the wire.
 *
 * `reserveSharedAudit` is the authoritative admission check — it takes the
 * account, grant, usage and key locks and re-reads consent inside the same
 * transaction, so anything it rejects was rejected against committed state.
 * The route deliberately does NOT pre-check the same predicates before
 * calling it: a second copy would be racy (it reads outside the lock) and
 * would eventually disagree with the transaction it is supposed to preview.
 *
 * Returns null for anything that is not a SharedLlmError so the caller
 * rethrows: an unexpected driver error must still reach the 500 handler
 * rather than being flattened into a 503 that reads like a quota problem.
 */
function sharedAdmissionFailure(error: unknown): SharedFailure | null {
  if (!(error instanceof SharedLlmError)) return null;
  switch (error.code) {
    case 'shared_audit_in_progress':
      // Recipient-scoped, not universe-scoped: the cap is one concurrent
      // shared run per recipient across every universe they own.
      return {
        status: 409,
        body: {
          error: 'A shared audit is already running for your account',
          code: 'shared_audit_in_progress',
        },
      };
    case 'shared_monthly_limit_exceeded':
      return SHARED_LIMIT_EXCEEDED;
    case 'shared_cost_invalid':
      return SHARED_COST_UNAVAILABLE;
    case 'shared_llm_consent_required':
      return SHARED_CONSENT_REQUIRED;
    case 'shared_access_revoked':
      // The grant was revoked (or its key swapped) between resolution and
      // the reservation lock. 403 rather than 503: nothing is going to fix
      // itself here, and a retry would be pointless.
      return {
        status: 403,
        body: { error: 'Shared access is no longer available', code: 'shared_access_revoked' },
      };
    default:
      return SHARED_CREDENTIAL_UNAVAILABLE;
  }
}

type RunCredential =
  | { kind: 'ready'; credential: ProviderCredential; effective: EffectiveLlmCredential | null }
  | { kind: 'none' }
  | { kind: 'failure'; failure: SharedFailure };

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

// ─── Route definitions ───────────────────────────────────────────────────────

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

// Phase 26 Plan 03 Task 2 — D-09 paginated audit-history list for the settings tab.
// Mount path resolves to /api/universes/:uid/audits (mounted in api/src/index.ts via
// `apiR.route('/universes/:uid', auditRoutes)`).
const listAuditHistoryRoute = createRoute({
  method: 'get',
  path: '/audits',
  tags: ['Audits'],
  summary: 'List past audit runs for a universe (paginated)',
  description:
    'D-09 audit history powering the AuditHistoryTable tab inside UniverseSettings ' +
    '(Plan 26-05 + Plan 26-06). Returns rows ordered by startedAt DESC. Aggregates ' +
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

// Phase 26 Plan 08 Task 1 — pre-run estimate endpoint (D-15/D-16).
// Mount path resolves to /api/universes/:uid/audits/estimate. MUST be defined
// (and registered .openapi'd) BEFORE the /audits/{runId} route — otherwise the
// dynamic {runId} matcher swallows /estimate. The route is INDEPENDENT of any
// existing run (dialog opens BEFORE a run exists; W-1 deviation from CONTEXT
// D-16's :runId path hint — see plan body <interfaces> resolution).
const getAuditEstimateRoute = createRoute({
  method: 'get',
  path: '/audits/estimate',
  tags: ['Audits'],
  summary: 'Pre-run cost-range estimate for a planned audit',
  description:
    'LLMUI-04 cost-range estimate computed by services/audit-estimator.ts. ' +
    'requireUniverse fires inline (T-24-05-02). audit_enabled=false → 403 ' +
    '(T-26-08-01: every audit-trigger surface honors Phase 24 SC-1 opt-in, ' +
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

// ─── Route export ────────────────────────────────────────────────────────────

export const auditRoutes = new OpenAPIHono<AppEnv>()

  // POST /api/universes/:uid/audit
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

    // Not one of the brief's enumerated touchpoints, but caught by the
    // union test (llm-provider-union.test.ts) anyway — same file, same
    // stale two-provider literal. universe.auditProvider is DB free text
    // (not Zod-validated at read time), so this cast is the only place the
    // widened type actually applies here.
    const provider = universe.auditProvider as LlmProvider;
    const model = universe.auditModel!;
    const cfg = env();

    // #50 Task 6: resolveRunCredential, not resolveCredential. For an Ollama
    // universe it IS resolveCredential (see the helper) — that seam, which
    // made the GET /estimate route 400 forever for endpoint providers, is
    // unchanged. For anthropic/openai it additionally admits a recipient who
    // has no own key but does hold a consented administrator grant.
    //
    // A shared caller is refused HERE, before any provider call and before
    // any row exists: an unconsented or unusable grant must not produce an
    // audit_runs row that the engine would then have to fail, because a
    // recipient reading their history cannot tell that kind of failed run
    // from one that actually consumed the owner's quota.
    const resolved = await resolveRunCredential(userId, provider, cfg.llmKeyEncryptionKey);
    if (resolved.kind === 'failure') {
      return c.json(resolved.failure.body, resolved.failure.status) as never;
    }
    const credential = resolved.kind === 'ready' ? resolved.credential : null;
    const effective = resolved.kind === 'ready' ? resolved.effective : null;

    // Pre-run cost estimate. Phase 26 Plan 08 Task 1: inline single-point math
    // REPLACED with a call to estimateAudit() (services/audit-estimator.ts) —
    // DRY single source of truth shared with the GET /audits/estimate dialog
    // route. Maps the AuditEstimate to the existing wire shape (promptTokens,
    // estCostUsd) so callers see no contract change.
    //
    // For an own-credential run this stays best-effort: failure must NOT block
    // the run, and the engine surfaces real telemetry either way. For a SHARED
    // run it is load-bearing — the estimate's upper bound is the reservation
    // amount, so there is no honest way to admit the run without one. Hence
    // the two outcomes are kept apart (`estimateResult` vs. the wire
    // `estimate`) instead of both collapsing into the {0,0} placeholder.
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
        // Preserve wire compat: AuditEstimate.breakdown.basePromptTokens → promptTokens,
        // AuditEstimate.lower → estCostUsd (lower bound matches the previous
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

    // ── Shared admission ────────────────────────────────────────────────────
    // The row itself is created by reserveSharedAudit, inside the same
    // transaction as the reservation and the usage counters. Inserting here
    // and reserving afterwards would leave a window where a run exists that
    // nothing has charged for — and a crash in that window leaks quota
    // permanently, because settlement keys off the reservation, not the run.
    if (effective?.source === 'shared') {
      if (!estimateResult) {
        // No bound, no reservation. Distinct from the 422 below: this one is
        // a transient provider/tokenizer failure and retrying is reasonable.
        return c.json(
          { error: 'Could not estimate run cost', code: 'estimate_unavailable' },
          502,
        ) as never;
      }
      if (estimateResult.upper <= 0) {
        // estimateAudit returns a zeroed estimate for a model absent from
        // PRICING (its Step 2 miss). An own-key run may proceed unpriced —
        // the user pays their own provider directly and the engine records
        // cost_unknown. A shared run may not: an uncapped charge against
        // someone else's key is exactly what the monthly limit exists to
        // prevent.
        return c.json(SHARED_COST_UNAVAILABLE.body, SHARED_COST_UNAVAILABLE.status) as never;
      }
      try {
        const reserved = await reserveSharedAudit({
          recipientUserId: userId,
          universeId: uid,
          scope: body.scope,
          scopeEntryId: body.entryId ?? null,
          // Narrowing is sound: source==='shared' is only ever produced for a
          // SharedProvider (llm-credential.ts refuses every other provider
          // before it looks for a grant).
          provider: provider as SharedProvider,
          model,
          grantId: effective.sharedGrantId!,
          credentialOwnerId: effective.credentialOwnerId,
          // Reserve the UPPER bound, clamped by the per-run ceiling the engine
          // itself enforces: reserving the lower bound would let a run that
          // legitimately lands mid-range overshoot the monthly cap, and
          // settlement refunds the difference anyway.
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
        if (failure) return c.json(failure.body, failure.status) as never;
        throw e;
      }
    }

    // INSERT audit_runs row with status='pending' BEFORE returning 202
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
          // #50 Task 6: own provenance written explicitly rather than left to
          // the column default. `credential_owner_id` is what the settlement
          // and revocation paths read to decide whether a run is chargeable
          // to someone else; leaving it NULL here would make "personal run"
          // and "shared run whose grant row was deleted" (the ON DELETE SET
          // NULL tombstone) indistinguishable after the fact.
          credentialSource: 'own',
          credentialOwnerId: userId,
          sharedGrantId: null,
        })
        .returning({ id: auditRuns.id });
      runId = id;
    } catch (e: unknown) {
      // BL-01 (Phase 24-07): Race-condition fallback. PG 23505 unique_violation fires when two
      // concurrent POSTs both pass the pre-check SELECT and both attempt INSERT. The partial
      // unique index audit_runs_universe_active_unique (drizzle/0009_phase24_audit_runs_concurrent_unique.sql)
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

  // GET /api/universes/:uid/audits — Phase 26 Plan 03 Task 2 (D-09 history)
  .openapi(listAuditHistoryRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const { limit, offset } = c.req.valid('query');
    const userId = c.var.userId;

    // T-26-03-04 / T-24-05-02: requireUniverse INLINE.
    await requireUniverse(uid, userId);

    // Base universe-scoped page: ORDER BY started_at DESC LIMIT ?n OFFSET ?n
    // LEFT JOIN entries for scopeEntryTitle (NULL for scope='universe' or deleted entry)
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
        // Phase 27 D-06: surface cost_unknown so the UI can render a chip
        // instead of a $0.0000 dollar amount.
        costUnknown: auditRuns.costUnknown,
        startedAt: auditRuns.startedAt,
        finishedAt: auditRuns.finishedAt,
        analyzedEntries: auditRuns.analyzedEntries,
        // #50 Task 6 — the ONLY provenance column selected. credentialOwnerId
        // and sharedGrantId are deliberately absent from this projection so
        // no later `...r` spread can leak them into the response.
        credentialSource: auditRuns.credentialSource,
      })
      .from(auditRuns)
      .leftJoin(entries, eq(entries.id, auditRuns.scopeEntryId))
      .where(eq(auditRuns.universeId, uid))
      .orderBy(desc(auditRuns.startedAt))
      .limit(limit)
      .offset(offset);

    // total count for this universe (same WHERE predicate)
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
            // equivalent and keeps the where clause minimal).
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

    // totalEntries: single COUNT(*) FROM entries WHERE universe_id = :uid;
    // applied to universe-scoped rows only. Entry-scoped rows get null
    // (per AuditHistoryRow JSDoc — totalEntries is ambiguous when scope=entry).
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
      costUnknown: r.costUnknown, // Phase 27 D-06
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

  // GET /api/universes/:uid/audits/estimate — Phase 26 Plan 08 Task 1 (D-15/D-16)
  // MUST appear before the /audits/{runId} binding so the literal `/estimate`
  // segment is matched before the dynamic {runId} matcher.
  .openapi(getAuditEstimateRoute, async (c) => {
    const { uid } = c.req.valid('param');
    const query = c.req.valid('query');
    const userId = c.var.userId;

    // T-24-05-02: requireUniverse INLINE
    const universe = await requireUniverse(uid, userId);

    // T-26-08-01: opt-in invariant preserved across the audit-trigger family.
    // Estimate is purely informational but the audit-trigger surface MUST NOT
    // bypass the opt-in (Phase 24 SC-1).
    if (!universe.auditEnabled) {
      throw new HTTPException(403, { message: 'Audit not enabled for this universe' });
    }

    // Resolve provider/model: query overrides universe defaults; both required.
    const provider = (query.provider ?? universe.auditProvider) as LlmProvider | null;
    const model = query.model ?? universe.auditModel;
    if (!provider || !model) {
      return c.json(
        { error: 'No provider/model configured for this universe' },
        400,
      );
    }

    // Resolve the user's credential for this provider — a decrypted API key
    // for anthropic/openai, a base URL (+ optional proxy bearer) for an
    // endpoint-based one.
    //
    // Fix round 2 (#48 whole-branch review, Critical 1): this used to call
    // getDecryptedKey unconditionally, which can NEVER succeed for 'ollama' —
    // KEY_PROVIDER_NAMES excludes it and llm-keys.ts is the only INSERT into
    // llm_api_keys, so no row can exist. The 400 below therefore fired on
    // every request for an Ollama universe, and that 400 is load-bearing on
    // the client: AuditCostDialog gates its Run button on a present estimate,
    // so a correctly configured user got a permanently disabled button while
    // the backend would have run the audit fine. resolveCredential is the one
    // place the key table and the connection table meet (spec D-3).
    //
    // #50 Task 6 widened this from resolveCredential to resolveRunCredential
    // so the dialog opens for a recipient running on an administrator grant.
    // The consent and owner-unusable refusals land here rather than after the
    // estimate for the same reason the trigger refuses early: calling the
    // provider would be a use of the owner's credential, and consent is
    // exactly what is supposed to gate that use.
    const cfg = env();
    const resolved = await resolveRunCredential(userId, provider, cfg.llmKeyEncryptionKey);
    if (resolved.kind === 'failure') {
      return c.json(resolved.failure.body, resolved.failure.status) as never;
    }
    if (resolved.kind === 'none') {
      // The two providers fail for genuinely different reasons and the copy
      // has to say which, or the user goes looking for the wrong settings
      // screen: there is no API key field for Ollama to fill in.
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

    // T-26-08-02: wrap the estimator in try/catch — provider failure surfaces
    // 502 with generic copy, NEVER leaks provider error text or stack.
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

    // A shared estimate is not just informational: the dialog's Run button
    // leads straight to an admission the recipient cannot pass if the run
    // does not fit. Answering 200 with a cost range and then 429-ing the
    // trigger is the "looks finished, does not work" failure this project
    // keeps paying for, so the same two gates the reservation applies are
    // previewed here.
    //
    // This is a PREVIEW, not a second copy of the rule: reserveSharedAudit
    // re-checks under its locks and remains the only thing that admits a run.
    // A preview that passes and a reservation that then fails is correct
    // behavior (someone else's run landed in between), not a contradiction.
    if (effective?.source === 'shared') {
      if (result.upper <= 0) {
        return c.json(SHARED_COST_UNAVAILABLE.body, SHARED_COST_UNAVAILABLE.status) as never;
      }
      const reservationUsd = roundUpToSixDecimals(Math.min(result.upper, cfg.auditMaxCostUsd));
      const quota = await getSharedQuotaSnapshot(userId);
      const committed = Number(quota.settledUsd) + Number(quota.reservedUsd);
      if (committed + reservationUsd > Number(quota.limitUsd)) {
        return c.json(SHARED_LIMIT_EXCEEDED.body, SHARED_LIMIT_EXCEEDED.status) as never;
      }
    }

    return c.json(result, 200);
  })

  // GET /api/universes/:uid/audits/:runId
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
        // Phase 27 D-06 — surface cost_unknown so AuditCompletionBanner can
        // render the amber chip when it polls via useAuditRun().
        costUnknown: run.costUnknown,
        triggerSource: run.triggerSource,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        gapKeyCollisionCount: run.gapKeyCollisionCount,
        hallucinatedEntryReferenceCount: run.hallucinatedEntryReferenceCount,
        suggestionCount: Number(suggestionCount),
        // #50 Task 6 — same rule as the history projection: the source, never
        // the owner or the grant. This handler selects the whole row, so the
        // field list below IS the redaction; adding a spread here would leak
        // both of the other provenance columns at once.
        credentialSource: run.credentialSource,
      },
      200
    );
  });

// ─── Cross-universe audit routes ─────────────────────────────────────────────
//
// Phase 26 Plan 03 — D-06 / D-16 cross-universe rollup.
//
// These routes are NOT mounted under /universes/:uid because they operate
// across ALL of the authed user's universes. requireUniverse does NOT fire;
// the only authorization filter is the `audit_runs.user_id = c.var.userId`
// predicate in the handler (T-26-03-01).
//
// Mount in api/src/index.ts:
//   apiR.route('/audits', auditCrossUniverseRoutes);
//   apiR.use('/audits/*', requireAuth);   // ← bearerAuth gate for the surface
//
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
  // NUMERIC(10,4) → string from pg (preserves precision; never a number)
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
    'D-06 cross-universe rollup powering the corner badge (Plan 26-05 InFlightAuditsBadge). ' +
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
    // LEFT JOIN universes for universeName; LEFT JOIN entries for scopeEntryTitle
    // (NULL when scope='universe' or when the entry was deleted via onDelete:'set null').
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
