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
import { and, eq, inArray, count } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { auditRuns, issues, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import { getProvider } from '../providers/llm/index.js';
import { PRICING } from '../providers/llm/pricing.js';
import { runAudit } from '../services/audit-engine.js';
import { getDecryptedKey } from '../services/llm-key.js';
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
  triggerSource: z.string(),
  error: z.string().nullable(),
  startedAt: z.string().or(z.date()),
  finishedAt: z.string().or(z.date()).nullable(),
  gapKeyCollisionCount: z.number().int(),
  hallucinatedEntryReferenceCount: z.number().int(),
  suggestionCount: z.number().int(),
});

const errorSchema = z.object({ error: z.string() });

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

    // Pre-run cost estimate — best-effort; catch failure and return placeholder
    let estimate: { promptTokens: number; estCostUsd: number } = { promptTokens: 0, estCostUsd: 0 };
    try {
      const provider = universe.auditProvider as 'anthropic' | 'openai';
      const model = universe.auditModel!;
      const cfg = env();
      const apiKey = await getDecryptedKey(userId, provider, cfg.llmKeyEncryptionKey);
      if (apiKey) {
        const tokenCount = await getProvider(provider).estimate({
          apiKey,
          messages: [
            { role: 'user', content: 'Audit estimate placeholder — structural digest not yet built.' },
          ],
          model,
        });
        // estCostUsd = input tokens × input rate per 1M tokens (lower bound — output not yet known)
        const pricing = (PRICING[provider] as Record<string, { inputUsdPer1M: number }>)[model];
        const estCostUsd = pricing
          ? (tokenCount / 1_000_000) * pricing.inputUsdPer1M
          : 0;
        estimate = { promptTokens: tokenCount, estCostUsd };
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
      // Race condition: PG 23505 partial-unique-index fallback (T-24-05-07)
      const code = (e as { code?: string } | null)?.code;
      if (code === '23505') {
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
