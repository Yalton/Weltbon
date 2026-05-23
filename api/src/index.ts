import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { env, type Env } from './config.js';
import { authRoutes } from './routes/auth.js';
import { tokenRoutes } from './routes/tokens.js';
import { inviteRoutes } from './routes/invites.js';
import { llmKeyRoutes } from './routes/llm-keys.js';
import { universeRoutes } from './routes/universes.js';
import { entryRoutes } from './routes/entries.js';
import { linkRoutes, relationRoutes } from './routes/links.js';
import { categoryRoutes } from './routes/categories.js';
import { issueRoutes } from './routes/issues.js';
import { graphRoutes, graphPositionRoutes } from './routes/graph.js';
import { exportRoutes } from './routes/export.js';
import { importRoutes } from './routes/import.js';
import { ingestRoutes } from './routes/ingest.js';
import { timelinePinRoutes, timelineListRoutes } from './routes/timeline.js';
import { requireAuth } from './middleware/auth.js';
import { forwarded } from './middleware/forwarded.js';
import { db } from './db/client.js';
import { llmApiKeys } from './db/schema.js';
import { seedInviteCode } from './db/seedInviteCode.js';
import { createApiRouter } from './openapi/app.js';
import { scalarHtml } from './openapi/scalar.js';

const cfg = env();

/**
 * Single source of truth for log-line redaction. Used by both the Hono logger
 * middleware (request lines) and app.onError (unhandled errors). Centralising
 * the regex set means a future leak class (new key prefix, new auth header)
 * can be added in one place and applied to every log surface — WR-07 fix.
 *
 * Patterns:
 *   - Authorization / Cookie header values — full value replaced
 *   - sk-ant-* and sk-* keys, anchored on {32,} (WR-05) so universe slugs
 *     like "sk-foo-uid" are not false-positive scrubbed
 *   - wbn_pat_* and wbn_inv_* tokens
 */
function scrubLogLine(msg: string): string {
  return msg
    .replace(/(authorization|cookie):\s*[^\n]+/gi, '$1: [redacted]')
    .replace(/sk-ant-[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{32,}/g, '[REDACTED]')
    .replace(/wbn_pat_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/wbn_inv_[A-Za-z0-9_-]+/g, '[REDACTED]');
}

export function createApp() {
  const app = new Hono();
  app.use('*', logger((msg) => {
    // LLMKEY-08 supporting safety control (D-04/D-05/D-06):
    // - sk-ant- must be replaced BEFORE the broader sk- so the specific prefix wins
    // - logger output only (D-05); HTTP response bodies are NOT scrubbed
    // - silent in all environments (D-06); no warning, no telemetry, no counter
    console.log(scrubLogLine(msg));
  }));
  app.use('*', cors({
    origin: (origin) => {
      // PROXY-01: when WELTBON_PUBLIC_ORIGIN is set, allow ONLY that origin.
      // When unset, retain the dev (o) => o reflect-all behavior (CONTEXT.md §CORS).
      if (cfg.publicOrigin) {
        return origin === cfg.publicOrigin ? origin : undefined;
      }
      return origin;
    },
    credentials: true,
  }));
  // PROXY-02: resolve the public origin once per request from X-Forwarded-* headers.
  app.use('*', forwarded);
  const apiR = createApiRouter();
  apiR.route('/auth/tokens', tokenRoutes);
  apiR.route('/llm-keys', llmKeyRoutes);
  apiR.route('/auth/invites', inviteRoutes);
  apiR.route('/auth', authRoutes);
  apiR.use('/universes/*', requireAuth);
  apiR.route('/universes/import', importRoutes);
  // 11-03: mount /universes/:uid/ingest BEFORE the bare /universes mount so
  // the more-specific path wins, mirroring the /universes/import precedence.
  apiR.route('/universes/:uid/ingest', ingestRoutes);
  apiR.route('/universes', universeRoutes);
  apiR.route('/universes/:uid/entries', entryRoutes);
  apiR.route('/universes/:uid/entries', timelinePinRoutes);
  apiR.route('/universes/:uid/links', linkRoutes);
  apiR.route('/universes/:uid/relations', relationRoutes);
  apiR.route('/universes/:uid/categories', categoryRoutes);
  apiR.route('/universes/:uid/issues', issueRoutes);
  apiR.route('/universes/:uid/graph-data', graphRoutes);
  apiR.route('/universes/:uid/graph-positions', graphPositionRoutes);
  apiR.route('/universes/:uid/export', exportRoutes);
  apiR.route('/universes/:uid', timelineListRoutes);
  app.route('/api', apiR);
  // D-08: OpenAPI schema at /api/openapi.json
  // D-07: Scalar docs at /api/docs — Hono-mounted so SPA fallback never intercepts
  app.get('/api/docs', (c) => c.html(scalarHtml));
  app.get('/api/openapi.json', (c) =>
    c.json(
      apiR.getOpenAPIDocument({
        openapi: '3.0.0',
        info: {
          title: 'Weltbon API',
          version: '1.0.0',
          description:
            'Weltbon is a free, self-hostable worldbuilding API. ' +
            'All authenticated endpoints accept either a JWT access token or a Personal Access Token (PAT). ' +
            'The PAT meta-API (/api/auth/tokens) is JWT-only (D-13). ' +
            'Rate limiting is not enforced in v2.0 — the operator owns the host.',
        },
        servers: [{ url: '/api', description: 'Weltbon API' }],
      })
    )
  );
  app.get('/health', (c) => c.json({ ok: true }));

  app.use('*', serveStatic({ root: './web-dist' }));
  app.get('/', serveStatic({ path: './web-dist/index.html' }));
  app.get('*', serveStatic({ path: './web-dist/index.html' }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    // WR-07 fix: scrub the error stack/message through the same redaction
    // function the request logger uses. If a future regression ever lets
    // plaintext (key, PAT, invite token) reach an Error message or stack,
    // this prevents it from being logged raw to stderr.
    const errText = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(scrubLogLine(errText));
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}

export const app = createApp();

/**
 * LLMKEY-08 boot-time conditional fail-fast.
 *
 * Aborts startup if the llm_api_keys table has any rows but
 * `LLM_KEY_ENCRYPTION_KEY` is unset. Exported as a callable function so
 * Plan 22-04's behavioral test can exercise the throw path directly with a
 * stubbed db + empty cfg, instead of relying on a grep gate.
 *
 * Semantics:
 *   - rows=0 + key unset → no-op (operator hasn't enabled BYOK yet)
 *   - rows=0 + key set → no-op (key present, no rows yet — fine)
 *   - rows>0 + key set → no-op (normal operation)
 *   - rows>0 + key unset → throw (would silently 503 every audit; LLMKEY-08 violation)
 */
export async function assertLlmKeyEncryptionKey(deps: {
  db: ReturnType<typeof db>;
  cfg: Env;
}): Promise<void> {
  const hasKeys = await deps.db.select({ id: llmApiKeys.id }).from(llmApiKeys).limit(1);
  if (hasKeys.length > 0 && !deps.cfg.llmKeyEncryptionKey) {
    throw new Error(
      'LLM_KEY_ENCRYPTION_KEY must be set when llm_api_keys rows exist. ' +
      'See README ## Self-Host for the backup callout (the key is unrecoverable if lost). ' +
      'Generate one with: openssl rand -hex 32'
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // PROXY-01 operator warning: when WELTBON_PUBLIC_ORIGIN is unset the CORS
  // middleware reflects any Origin back with credentials: true — fine for
  // local dev, an XS-attack surface in production. Surface it loudly at boot.
  if (!cfg.publicOrigin) {
    console.warn(
      '[weltbon] WELTBON_PUBLIC_ORIGIN is not set — CORS will reflect any Origin with credentials. ' +
      'This is acceptable for local dev. For production, set WELTBON_PUBLIC_ORIGIN=https://your.domain ' +
      'to restrict CORS to your operator-controlled origin.'
    );
  }
  await seedInviteCode(db());
  await assertLlmKeyEncryptionKey({ db: db(), cfg });
  serve({ fetch: app.fetch, port: cfg.port });
  console.log(`Weltbon API listening on :${cfg.port}`);
}
