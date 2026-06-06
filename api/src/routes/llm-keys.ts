/**
 * Phase 22 BYOK — /api/llm-keys/* route table.
 *
 * Five OpenAPI routes mounted at /api/llm-keys/*:
 *   POST   /                    create + validate-before-encrypt-before-insert (D-01..D-03)
 *   GET    /                    list (masked — never includes ciphertext/iv/authTag/plaintext)
 *   PUT    /{id}                replace key for an existing (userId, provider) row
 *   DELETE /{id}                revoke (delete) the row
 *   POST   /{id}/revalidate     re-ping the provider; update last_validated_at on success
 *
 * Every route applies requireJwtAuth via the per-route middleware array (LLMKEY-06 /
 * D-13 mirror), so a PAT bearer cannot reach any mutation. The GET also uses requireJwtAuth
 * per the <interfaces> minimal-surface decision (PATs cannot enumerate the inventory).
 *
 * Strict-state model (D-01..D-03):
 *   1. Parse + validate JSON (Zod failure → 400)
 *   2. Look up auth user (middleware set c.var.userId)
 *   3. Pre-check existing row for (userId, provider) → 409 "Use PUT to replace"
 *   4. Provider validate — InvalidApiKey → 422; other LLMError variants → 503
 *      (Phase 23 D-03 migration; routed through the provider abstraction at
 *      api/src/providers/llm/.)
 *   5. encryptKey(plaintext, cfg.llmKeyEncryptionKey) — missing env → 503
 *   6. INSERT — catch PG 23505 UNIQUE collision → 409
 *   7. Map row → masked response shape (toMaskedRow); never echo ciphertext/iv/authTag/plaintext.
 *
 * No console.log / console.info / console.warn / console.error anywhere in this file —
 * D-03 forbids logging the rejected-key attempt; the route returns the error message
 * via c.json({ error }) and that is the only signal.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { llmApiKeys, users, auditRuns } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import {
  encryptKey,
  getDecryptedKey,
  type LlmProvider,
} from '../services/llm-key.js';
import {
  getProvider,
  getModels,
  LLMProviderError,
  LLMError,
} from '../providers/llm/index.js';
import type { ModelPricing } from '../providers/llm/index.js';
import { env } from '../config.js';

type AppEnv = { Variables: AuthVariables };

// ─── Zod schemas ────────────────────────────────────────────────────────────

const errorSchema = z.object({
  error: z.string(),
});

const providerEnum = z.enum(['anthropic', 'openai']);

const postBodySchema = z.object({
  provider: providerEnum,
  key: z.string().min(1),
  label: z.string().optional().default(''),
});

const putBodySchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const maskedKeySchema = z.object({
  id: z.string().uuid(),
  provider: providerEnum,
  bodySuffix: z.string(),
  label: z.string(),
  createdAt: z.string(),
  lastValidatedAt: z.string().nullable(),
});

/**
 * Phase 26 Plan 08 Task 3 (D-14) — masked row + per-provider cumulative cost.
 * Phase 27 Plan 03 (D-06) — adds unknownCount: runs with cost_unknown=true are
 * excluded from totalSpentUsd SUM; their count is reported separately.
 *
 * `totalSpentUsd` is `SUM(audit_runs.cost_usd) FILTER (WHERE cost_unknown = false)
 * WHERE user_id = caller AND provider = key.provider`, formatted as a 4-decimal
 * string (cost-as-string convention; NEVER a number). Always a string — '0.0000'
 * when no runs match.
 *
 * `unknownCount` is the count of runs with cost_unknown=true for this
 * (provider, user_id) pairing. Defaults to 0 when no such runs exist.
 *
 * Approximation: joined by (provider, user_id), not byok_key_id. If a user
 * has multiple keys for the same provider, all rows show the same total
 * (Phase 22 schema choice; documented limitation per CONTEXT D-14).
 */
const maskedKeyWithSpentSchema = maskedKeySchema.extend({
  /**
   * Sum of audit_runs.cost_usd (cost_unknown=false only) matched by
   * (provider, user_id). Per D-14/D-06.
   */
  totalSpentUsd: z.string(),
  /**
   * Count of runs with cost_unknown=true for this (provider, user_id).
   * Phase 27 D-06 SUM-safe rollup: unpriced runs excluded from totalSpentUsd.
   */
  unknownCount: z.number().int().nonnegative(),
});

// ─── Phase 27 Plan 03 Task 1 — /models response schema ──────────────────────

/**
 * ModelPricing-compatible Zod schema for the wire shape.
 * Matches the ModelPricing type from pricing.ts (both providers share the same
 * numeric field set except cacheWriteUsdPer1M which is Anthropic-only).
 */
const modelPricingSchema = z.object({
  inputUsdPer1M: z.number(),
  outputUsdPer1M: z.number(),
  cachedInputUsdPer1M: z.number(),
  cacheWriteUsdPer1M: z.number().optional(),
  contextWindow: z.number().int().optional(),
});

/**
 * Phase 27 Plan 03 — GET /models response wire shape.
 * `{ models: [{id, hasPricing, pricing?}], source, fetchedAt }`
 * Per CONTEXT §Specifics + 27-03-PLAN.md Task 1.
 */
const modelsResponseSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      hasPricing: z.boolean(),
      pricing: modelPricingSchema.optional(),
    }),
  ),
  source: z.enum(['live', 'cache_stale', 'pricing_fallback']),
  fetchedAt: z.string(),
});

const revalidateResponseSchema = z.object({
  id: z.string().uuid(),
  lastValidatedAt: z.string(),
});

const consentGetResponseSchema = z.object({
  consentedAt: z.string().nullable(),
});

const consentPostResponseSchema = z.object({
  consentedAt: z.string(),
});

// ─── Masked-row helper (LLMKEY-03 masking invariant) ────────────────────────

type LlmApiKeyRow = typeof llmApiKeys.$inferSelect;

function toMaskedRow(row: LlmApiKeyRow): {
  id: string;
  provider: LlmProvider;
  bodySuffix: string;
  label: string;
  createdAt: string;
  lastValidatedAt: string | null;
} {
  return {
    id: row.id,
    provider: row.provider as LlmProvider,
    bodySuffix: row.bodySuffix,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastValidatedAt: row.lastValidatedAt ? row.lastValidatedAt.toISOString() : null,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

const postRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['LLM API Keys'],
  summary: 'Add an LLM provider API key',
  description:
    'Validates the key against the provider, encrypts it with AES-256-GCM, and persists. ' +
    'JWT auth required (LLMKEY-06 / D-13 mirror: PATs cannot mint LLM keys). ' +
    'Strict-state: the DB never holds a row that was not confirmed valid by the provider.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: postBodySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: maskedKeySchema } },
      description: 'Key validated, encrypted, and stored. Response is masked.',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error (e.g. unknown provider, missing key).',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token (or PAT — see LLMKEY-06).',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'A key for this provider already exists. Use PUT to replace.',
    },
    422: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Provider rejected the key as invalid (D-03).',
    },
    503: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Provider transient failure / timeout, or server not configured.',
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['LLM API Keys'],
  summary: 'List the caller\'s LLM provider keys',
  description:
    'Returns the caller\'s configured LLM keys with masked metadata only ' +
    '(provider, bodySuffix, label, timestamps). Ciphertext is never returned. ' +
    'JWT auth required (minimal-surface; PATs cannot enumerate the inventory).',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(maskedKeyWithSpentSchema) } },
      description: 'Array of masked LLM key rows with totalSpentUsd per row (D-14).',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token.',
    },
  },
});

const putRoute = createRoute({
  method: 'put',
  path: '/{id}',
  tags: ['LLM API Keys'],
  summary: 'Replace an existing LLM provider key',
  description:
    'Replaces the key for the (userId, provider) row identified by id. Provider is taken ' +
    'from the existing row (not the request) — UNIQUE(user_id, provider) means a different ' +
    'provider is a different row entirely. Validate-before-encrypt-before-update.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: idParamSchema,
    body: {
      content: { 'application/json': { schema: putBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: maskedKeySchema } },
      description: 'Key replaced. Response is masked.',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Row not found / not owned.' },
    422: { content: { 'application/json': { schema: errorSchema } }, description: 'Provider rejected the key.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Provider transient / server unconfigured.' },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['LLM API Keys'],
  summary: 'Delete an LLM provider key',
  description: 'Deletes the row if it belongs to the caller. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: idParamSchema,
  },
  responses: {
    204: {
      description: 'Row deleted.',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Row not found / not owned.' },
  },
});

const revalidateRoute = createRoute({
  method: 'post',
  path: '/{id}/revalidate',
  tags: ['LLM API Keys'],
  summary: 'Re-validate an LLM provider key',
  description:
    'Decrypts the stored key and pings the provider. On success updates last_validated_at ' +
    'and returns the new timestamp. On rejection returns 422 but does NOT delete the row — ' +
    'the user decides whether to replace or revoke.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: revalidateResponseSchema } },
      description: 'Provider confirmed; last_validated_at advanced.',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Row not found / not owned.' },
    422: { content: { 'application/json': { schema: errorSchema } }, description: 'Provider rejected the key.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Provider transient / decryption unavailable.' },
  },
});

const getConsentRoute = createRoute({
  method: 'get',
  path: '/consent',
  tags: ['LLM API Keys'],
  summary: 'Get the caller\'s LLM consent state',
  description:
    'Returns the timestamp the caller accepted the LLM consent block, or null if not yet accepted. ' +
    'JWT auth required (LLMKEY-06 / D-13 mirror — consent is downstream of key entry).',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: consentGetResponseSchema } },
      description: 'Consent state for the caller.',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token (or PAT — LLMKEY-06).',
    },
  },
});

/**
 * Phase 27 Plan 03 Task 1 — GET /api/llm-keys/models
 *
 * JWT-only (requireJwtAuth — D-13 mirror; PAT bearer 401).
 * Returns the hybrid model catalog for the caller's own key for the given provider.
 *
 * Security:
 *   T-27-03-01: keyId resolved server-side from JWT subject — NEVER from client.
 *   T-27-03-02: requireJwtAuth blocks PAT bearers (401).
 *   T-27-03-04: providerEnum validates + rejects unknown providers.
 *   T-27-03-03: env-gate 503 when LLM_KEY_ENCRYPTION_KEY unset.
 */
const getModelsRoute = createRoute({
  method: 'get',
  path: '/models',
  tags: ['LLM API Keys'],
  summary: 'List live models for a provider key (hybrid catalog)',
  description:
    'Returns the hybrid model catalog for the caller\'s own key for the requested provider. ' +
    'JWT auth required (PAT bearer → 401). keyId is resolved server-side from the authenticated ' +
    'user; the client never supplies a keyId (T-27-03-01 / V4 access control). ' +
    'Calls getModels(provider, keyId, apiKey) which implements the 3-tier fallback (D-01/D-02): ' +
    '(1) live provider.models.list() with 30-min TTL cache; (2) stale cache on live-fail; ' +
    '(3) PRICING keys as last resort. Returns 404 when the user has no key for the provider. ' +
    'Returns 503 when LLM_KEY_ENCRYPTION_KEY is unset.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    query: z.object({ provider: providerEnum }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: modelsResponseSchema } },
      description: 'Hybrid model catalog — list of model entries with pricing metadata.',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token (or PAT — LLMKEY-06 / T-27-03-02).',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'No key configured for the requested provider.',
    },
    422: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Provider rejected the key.',
    },
    503: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Server not configured (LLM_KEY_ENCRYPTION_KEY unset) or provider transient failure.',
    },
  },
});

const postConsentRoute = createRoute({
  method: 'post',
  path: '/consent',
  tags: ['LLM API Keys'],
  summary: 'Record the caller\'s acceptance of the LLM consent block',
  description:
    'Sets users.llm_consented_at = NOW() for the caller. Idempotent: if already set, returns the ' +
    'persisted timestamp unchanged (D-07: consent persists forever; re-acceptance is a no-op). ' +
    'JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: consentPostResponseSchema } },
      description: 'Consent recorded (or already present — idempotent return).',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token (or PAT — LLMKEY-06).',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'User row not found (deleted between token issuance and consent POST).',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Consent state could not be recorded (defensive — COALESCE returned null).',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const llmKeyRoutes = new OpenAPIHono<AppEnv>()

  .openapi(postRoute, async (c) => {
    const cfg = env();
    if (!cfg.llmKeyEncryptionKey) {
      return c.json(
        {
          error:
            'Server is not configured for LLM key encryption. ' +
            'Operator must set LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
        },
        503,
      );
    }

    const userId = c.var.userId;
    const { provider, key: plaintext, label } = c.req.valid('json');

    // Pre-check existing row for (userId, provider) — 409 if present.
    const existing = await getDb()
      .select({ id: llmApiKeys.id })
      .from(llmApiKeys)
      .where(and(eq(llmApiKeys.userId, userId), eq(llmApiKeys.provider, provider)))
      .limit(1);
    if (existing.length > 0) {
      return c.json(
        { error: 'A key for this provider already exists. Use PUT /api/llm-keys/{id} to replace it.' },
        409,
      );
    }

    // Validate at provider BEFORE encrypt BEFORE insert (D-01..D-03 strict-state).
    // Phase 23 D-03: routed through getProvider(provider).validate() — InvalidApiKey → 422,
    // every other LLMError variant → 503 (preserves Phase 22 HTTP behavior).
    try {
      await getProvider(provider).validate(plaintext);
    } catch (err) {
      if (err instanceof LLMProviderError) {
        if (err.variant === LLMError.InvalidApiKey) {
          return c.json({ error: err.message }, 422);
        }
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }

    // Encrypt + insert. Catch 23505 race-condition collision.
    const enc = encryptKey(plaintext, cfg.llmKeyEncryptionKey);
    try {
      const [row] = await getDb()
        .insert(llmApiKeys)
        .values({
          userId,
          provider,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          encryptedKeyVersion: enc.version,
          bodySuffix: enc.bodySuffix,
          label,
          lastValidatedAt: new Date(),
        })
        .returning();
      return c.json(toMaskedRow(row), 200);
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (code === '23505') {
        return c.json(
          { error: 'A key for this provider already exists. Use PUT /api/llm-keys/{id} to replace it.' },
          409,
        );
      }
      throw e;
    }
  })

  .openapi(getRoute, async (c) => {
    const userId = c.var.userId;
    const rows = await getDb()
      .select()
      .from(llmApiKeys)
      .where(eq(llmApiKeys.userId, userId))
      .orderBy(desc(llmApiKeys.createdAt));

    // Phase 26 Plan 08 Task 3 (D-14) — per-provider cumulative cost.
    // T-26-08-05: strict user_id filter ensures cross-tenant isolation.
    // Approximation: joined by (provider, user_id), not byok_key_id — if user
    // has multiple keys per provider, they all show the same total.
    // NUMERIC(10,4) is preserved as a string (cost-as-string convention).
    const spentRows = await getDb()
      .select({
        provider: auditRuns.provider,
        // COALESCE → '0' when GROUP BY yields no rows for the provider; toFixed(4)
        // below normalizes to the 4-decimal wire shape.
        total: sql<string>`COALESCE(SUM(${auditRuns.costUsd}), 0)::text`,
      })
      .from(auditRuns)
      .where(eq(auditRuns.userId, userId))
      .groupBy(auditRuns.provider);

    const spentByProvider = new Map<string, string>();
    for (const r of spentRows) {
      // Normalize to 4-decimal string. Parsing as Number then toFixed preserves
      // precision for sums within audit_runs.cost_usd's NUMERIC(10,4) range
      // (~$1,000,000 max) without losing the trailing zeros required by the UI.
      spentByProvider.set(r.provider, Number(r.total).toFixed(4));
    }

    return c.json(
      rows.map((r) => ({
        ...toMaskedRow(r),
        totalSpentUsd: spentByProvider.get(r.provider) ?? '0.0000',
      })),
      200,
    );
  })

  .openapi(putRoute, async (c) => {
    const cfg = env();
    if (!cfg.llmKeyEncryptionKey) {
      return c.json(
        {
          error:
            'Server is not configured for LLM key encryption. ' +
            'Operator must set LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
        },
        503,
      );
    }

    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const { key: plaintext, label } = c.req.valid('json');

    // Look up existing row by id + userId; 404 if not found / not owned.
    const existingRows = await getDb()
      .select()
      .from(llmApiKeys)
      .where(and(eq(llmApiKeys.id, id), eq(llmApiKeys.userId, userId)))
      .limit(1);
    if (existingRows.length === 0) {
      return c.json({ error: 'LLM key not found' }, 404);
    }
    const existingRow = existingRows[0];
    const provider = existingRow.provider as LlmProvider;

    // Validate new plaintext against the EXISTING row's provider (not from request).
    // Phase 23 D-03: routed through getProvider(provider).validate().
    try {
      await getProvider(provider).validate(plaintext);
    } catch (err) {
      if (err instanceof LLMProviderError) {
        if (err.variant === LLMError.InvalidApiKey) {
          return c.json({ error: err.message }, 422);
        }
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }

    // Encrypt + update.
    const enc = encryptKey(plaintext, cfg.llmKeyEncryptionKey);
    const updateValues: {
      ciphertext: string;
      iv: string;
      authTag: string;
      encryptedKeyVersion: 1;
      bodySuffix: string;
      lastValidatedAt: Date;
      label?: string;
    } = {
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      encryptedKeyVersion: enc.version,
      bodySuffix: enc.bodySuffix,
      lastValidatedAt: new Date(),
    };
    if (label !== undefined) {
      updateValues.label = label;
    }
    const [row] = await getDb()
      .update(llmApiKeys)
      .set(updateValues)
      .where(and(eq(llmApiKeys.id, id), eq(llmApiKeys.userId, userId)))
      .returning();
    return c.json(toMaskedRow(row), 200);
  })

  .openapi(deleteRoute, async (c) => {
    const userId = c.var.userId;
    const { id } = c.req.valid('param');
    const deleted = await getDb()
      .delete(llmApiKeys)
      .where(and(eq(llmApiKeys.id, id), eq(llmApiKeys.userId, userId)))
      .returning({ id: llmApiKeys.id });
    if (deleted.length === 0) {
      return c.json({ error: 'LLM key not found' }, 404);
    }
    return c.body(null, 204);
  })

  .openapi(revalidateRoute, async (c) => {
    const cfg = env();
    const userId = c.var.userId;
    const { id } = c.req.valid('param');

    // Look up row first to confirm ownership and obtain provider.
    const rows = await getDb()
      .select()
      .from(llmApiKeys)
      .where(and(eq(llmApiKeys.id, id), eq(llmApiKeys.userId, userId)))
      .limit(1);
    if (rows.length === 0) {
      return c.json({ error: 'LLM key not found' }, 404);
    }
    const row = rows[0];
    const provider = row.provider as LlmProvider;

    // CR-01 fix: pass cfg.llmKeyEncryptionKey explicitly — same source of truth as
    // the boot fail-fast and the POST/PUT 503 gates. getDecryptedKey no longer
    // re-reads process.env, eliminating the post-boot env-mutation drift hazard.
    // null collapses (D-11) no-row / decrypt-fail / missing-env / malformed-env / version-mismatch.
    const plaintext = await getDecryptedKey(userId, provider, cfg.llmKeyEncryptionKey);
    if (plaintext === null) {
      return c.json(
        {
          error:
            'Server cannot decrypt the stored key. ' +
            'Operator must verify LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
        },
        503,
      );
    }

    // Validate at provider. Phase 23 D-03: routed through getProvider(provider).validate().
    try {
      await getProvider(provider).validate(plaintext);
    } catch (err) {
      if (err instanceof LLMProviderError) {
        if (err.variant === LLMError.InvalidApiKey) {
          // D-03: do NOT delete the row automatically; the user decides.
          return c.json({ error: err.message }, 422);
        }
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }

    // Update last_validated_at and return the new timestamp.
    const now = new Date();
    const [updated] = await getDb()
      .update(llmApiKeys)
      .set({ lastValidatedAt: now })
      .where(and(eq(llmApiKeys.id, id), eq(llmApiKeys.userId, userId)))
      .returning({ id: llmApiKeys.id, lastValidatedAt: llmApiKeys.lastValidatedAt });

    return c.json(
      {
        id: updated.id,
        lastValidatedAt: (updated.lastValidatedAt ?? now).toISOString(),
      },
      200,
    );
  })

  .openapi(getConsentRoute, async (c) => {
    const userId = c.var.userId;
    const rows = await getDb()
      .select({ llmConsentedAt: users.llmConsentedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (rows.length === 0) {
      // Row missing for an authenticated userId is a server-side anomaly; surface as null.
      return c.json({ consentedAt: null }, 200);
    }
    const row = rows[0];
    return c.json(
      {
        consentedAt: row.llmConsentedAt ? row.llmConsentedAt.toISOString() : null,
      },
      200,
    );
  })

  .openapi(getModelsRoute, async (c) => {
    // T-27-03-03 env-gate: decrypt requires the encryption key
    const cfg = env();
    if (!cfg.llmKeyEncryptionKey) {
      return c.json(
        {
          error:
            'Server is not configured for LLM key encryption. ' +
            'Operator must set LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
        },
        503,
      );
    }

    const userId = c.var.userId;
    const { provider } = c.req.valid('query');

    // T-27-03-01 / V4: resolve keyId server-side from (userId, provider).
    // NEVER accept keyId from the client — cross-tenant enumeration risk (Pitfall #6).
    const keyRows = await getDb()
      .select({ id: llmApiKeys.id })
      .from(llmApiKeys)
      .where(and(eq(llmApiKeys.userId, userId), eq(llmApiKeys.provider, provider)))
      .limit(1);

    if (keyRows.length === 0) {
      return c.json({ error: `No key configured for provider ${provider}` }, 404);
    }
    const keyId = keyRows[0].id;

    // Decrypt the stored key (null collapses decrypt-fail / missing-env / version-mismatch)
    const plaintext = await getDecryptedKey(userId, provider as LlmProvider, cfg.llmKeyEncryptionKey);
    if (plaintext === null) {
      return c.json(
        {
          error:
            'Server cannot decrypt the stored key. ' +
            'Operator must verify LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
        },
        503,
      );
    }

    // Call getModels — 3-tier fallback (live → stale cache → PRICING keys)
    // T-27-03-03: map LLMProviderError variants → status; never log plaintext
    try {
      const result = await getModels(provider as LlmProvider, keyId, plaintext);
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof LLMProviderError) {
        if (err.variant === LLMError.InvalidApiKey) {
          return c.json({ error: err.message }, 422);
        }
        return c.json({ error: err.message }, 503);
      }
      throw err;
    }
  })

  .openapi(postConsentRoute, async (c) => {
    const userId = c.var.userId;

    // WR-01 fix: atomic COALESCE UPDATE — set llm_consented_at = NOW() ONLY if
    // currently NULL. This eliminates the read-then-update race (D-07
    // idempotency contract held only under serial calls; two concurrent POSTs
    // could each pass an existing=null read and both UPDATE with slightly
    // different NOW() values, leaving two distinct response timestamps for the
    // same user). The COALESCE keeps any already-set value untouched, makes
    // the route idempotent under arbitrary concurrency, and saves the SELECT
    // round-trip.
    //
    // BL-01 fix: detect zero-row UPDATE (user deleted between token issuance
    // and consent POST). Use .returning() and check row count; never fabricate
    // a `now` timestamp when nothing was persisted.
    const updatedRows = await getDb()
      .update(users)
      .set({ llmConsentedAt: sql`COALESCE(${users.llmConsentedAt}, NOW())` })
      .where(eq(users.id, userId))
      .returning({ llmConsentedAt: users.llmConsentedAt });

    if (updatedRows.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    const persisted = updatedRows[0].llmConsentedAt;
    if (!persisted) {
      // Defensive: COALESCE with NOW() should never return null, but if the DB
      // ever surprises us, surface a 500 rather than a fabricated timestamp.
      return c.json({ error: 'Consent state could not be recorded' }, 500);
    }
    return c.json({ consentedAt: persisted.toISOString() }, 200);
  });
