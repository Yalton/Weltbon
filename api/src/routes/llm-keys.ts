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
 *   4. validateAtProvider(plaintext, provider) — rejected → 422; transient/timeout → 503
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
import { llmApiKeys, users } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import {
  encryptKey,
  getDecryptedKey,
  validateAtProvider,
  ProviderValidationError,
  type LlmProvider,
} from '../services/llm-key.js';
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
      content: { 'application/json': { schema: z.array(maskedKeySchema) } },
      description: 'Array of masked LLM key rows.',
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
    try {
      await validateAtProvider(plaintext, provider);
    } catch (err) {
      if (err instanceof ProviderValidationError) {
        if (err.kind === 'rejected') {
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
    return c.json(rows.map(toMaskedRow), 200);
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
    try {
      await validateAtProvider(plaintext, provider);
    } catch (err) {
      if (err instanceof ProviderValidationError) {
        if (err.kind === 'rejected') {
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

    // Validate at provider.
    try {
      await validateAtProvider(plaintext, provider);
    } catch (err) {
      if (err instanceof ProviderValidationError) {
        if (err.kind === 'rejected') {
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
