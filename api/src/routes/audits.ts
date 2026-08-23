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
import { getDecryptedKey, PROVIDER_NAMES, type LlmProvider } from '../services/llm-key.js';
import { estimateAudit } from '../services/audit-estimator.js';
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
});

const errorSchema = z.object({ error: z.string() });

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
      description: 'An audit is already in progress for this universe',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
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
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
    502: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Estimator failed to compute cost (provider outage / token-count failure)',
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

    // Pre-run cost estimate — best-effort; catch failure and return placeholder.
    // Phase 26 Plan 08 Task 1: inline single-point math REPLACED with a call
    // to estimateAudit() (services/audit-estimator.ts) — DRY single source of
    // truth shared with the GET /audits/estimate dialog route. Maps the
    // AuditEstimate to the existing wire shape (promptTokens, estCostUsd) so
    // callers see no contract change.
    let estimate: { promptTokens: number; estCostUsd: number } = { promptTokens: 0, estCostUsd: 0 };
    try {
      // Not one of the brief's enumerated touchpoints, but caught by the
      // union test (llm-provider-union.test.ts) anyway — same file, same
      // stale two-provider literal. universe.auditProvider is DB free text
      // (not Zod-validated at read time), so this cast is the only place the
      // widened type actually applies here.
      const provider = universe.auditProvider as LlmProvider;
      const model = universe.auditModel!;
      const cfg = env();
      const apiKey = await getDecryptedKey(userId, provider, cfg.llmKeyEncryptionKey);
      if (apiKey) {
        const result = await estimateAudit({
          universeId: uid,
          scope: body.scope,
          entryId: body.entryId,
          provider,
          model,
          apiKey,
          userId,
        });
        // Preserve wire compat: AuditEstimate.breakdown.basePromptTokens → promptTokens,
        // AuditEstimate.lower → estCostUsd (lower bound matches the previous
        // input-tokens-only point estimate semantics most closely).
        estimate = {
          promptTokens: result.breakdown.basePromptTokens,
          estCostUsd: result.lower,
        };
      }
    } catch {
      // Estimate failure must NOT block the run — engine will surface real telemetry
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

    // Resolve decrypted API key for the user+provider — required for the
    // estimator's basePromptTokens call (provider local tokenizer).
    const cfg = env();
    const apiKey = await getDecryptedKey(userId, provider, cfg.llmKeyEncryptionKey);
    if (!apiKey) {
      return c.json({ error: `No API key configured for ${provider}` }, 400);
    }

    // T-26-08-02: wrap the estimator in try/catch — provider failure surfaces
    // 502 with generic copy, NEVER leaks provider error text or stack.
    try {
      const result = await estimateAudit({
        universeId: uid,
        scope: query.scope,
        entryId: query.entryId,
        provider,
        model,
        apiKey,
        userId,
      });
      return c.json(result, 200);
    } catch {
      return c.json({ error: 'Could not estimate run cost' }, 502);
    }
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
