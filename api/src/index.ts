import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { env, type Env } from './config.js';
import { buildAuthRoutes } from './routes/auth.js';
import { tokenRoutes } from './routes/tokens.js';
import { templates } from './routes/templates.js';
import { inviteRoutes } from './routes/invites.js';
import { adminUserRoutes } from './routes/admin-users.js';
import { adminInviteRequestRoutes, inviteRequestRoutes } from './routes/invite-requests.js';
import { adminLlmShareRoutes } from './routes/admin-llm-shares.js';
import { shareCrudRoutes } from './routes/shares.js';
import { shareRoutes } from './routes/share.js';
import { llmKeyRoutes } from './routes/llm-keys.js';
import { llmShareRoutes } from './routes/llm-shares.js';
import { llmModelsRoutes } from './routes/llm-models.js';
import { llmConnectionRoutes } from './routes/llm-connections.js';
import { configRoutes } from './routes/config.js';
import { versionRoutes } from './routes/version.js';
import { universeRoutes } from './routes/universes.js';
import { entryRoutes } from './routes/entries.js';
import { linkRoutes, relationRoutes, linkTypeRoutes } from './routes/links.js';
import { categoryRoutes } from './routes/categories.js';
import { issueRoutes } from './routes/issues.js';
import { graphRoutes, graphPositionRoutes } from './routes/graph.js';
import { exportRoutes } from './routes/export.js';
import { importRoutes } from './routes/import.js';
import { ingestRoutes } from './routes/ingest.js';
import { timelinePinRoutes, timelineListRoutes } from './routes/timeline.js';
import { auditRoutes, auditCrossUniverseRoutes } from './routes/audits.js';
import { statsRoutes } from './routes/stats.js';
import { diagramsRouter } from './routes/diagrams.js';
import { mapsRouter } from './routes/maps.js';
import { mapLayersRouter } from './routes/map-layers.js';
import { assetsRouter } from './routes/assets.js';
import { dictionaryRoutes } from './routes/dictionary.js';
import { syncRoutes } from './routes/sync.js';
import { syncClientRoutes } from './routes/sync-client.js';
import { buildRuntimeRoutes } from './routes/runtime.js';
import { recoverOrphanAuditRuns } from './services/audit-recovery.js';
import { recoverOrphanSyncLinks } from './services/sync/link-recovery.js';
import { createScheduler } from './services/sync/scheduler.js';
import { wireSigtermDrain } from './services/audit-shutdown.js';
import { requireAuth } from './middleware/auth.js';
import { forwarded } from './middleware/forwarded.js';
import { db, initDb, closeDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { llmApiKeys, syncRemotes } from './db/schema.js';
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
    .replace(/wbn_inv_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/wbn_share_[A-Za-z0-9_-]+/g, '[REDACTED]');
}

function isSharedLlmPath(path: string): boolean {
  return path === '/api/llm-shares'
    || path.startsWith('/api/llm-shares/')
    || path === '/api/admin/llm-shares'
    || path.startsWith('/api/admin/llm-shares/');
}

function sharedLlmErrorResponse(err: HTTPException): {
  status: 400 | 401 | 403 | 404 | 409 | 503;
  body: { error: string; code: string };
} {
  if (err.status === 401) {
    if (err.message === 'Missing bearer token') {
      return { status: 401, body: { error: err.message, code: 'missing_bearer_token' } };
    }
    return { status: 401, body: { error: 'Invalid token', code: 'invalid_token' } };
  }
  if (err.status === 403) {
    if (err.message === 'Administrator JWT required') {
      return { status: 403, body: { error: err.message, code: 'administrator_jwt_required' } };
    }
    return { status: 403, body: { error: 'Administrator required', code: 'administrator_required' } };
  }
  if (err.status === 400) {
    return { status: 400, body: { error: 'Invalid shared connection request', code: 'invalid_request' } };
  }
  if (err.status === 404) {
    return { status: 404, body: { error: 'Shared connection not found', code: 'shared_connection_not_found' } };
  }
  if (err.status === 409) {
    return { status: 409, body: { error: 'An active shared connection already exists', code: 'shared_connection_exists' } };
  }
  return {
    status: 503,
    body: { error: 'Shared connection is temporarily unavailable', code: 'shared_connection_unavailable' },
  };
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
  apiR.route('/admin', adminUserRoutes);
  apiR.route('/admin/llm-shares', adminLlmShareRoutes);
  apiR.route('/admin/invite-requests', adminInviteRequestRoutes);
  apiR.route('/templates', templates);
  apiR.route('/llm-keys', llmKeyRoutes);
  apiR.route('/llm-shares', llmShareRoutes);
  // to the full /api/llm/models URL. JWT-only via the route's own requireJwtAuth
  // middleware — no apiR.use() needed (mirrors llmKeyRoutes' per-route gate).
  apiR.route('/', llmModelsRoutes);
  // `requireAuth`, deliberately, so a share-token-only request cannot reach it
  // (SHARE-03 / T-29-22). The frontend reads `localMode` from it after login,
  apiR.route('/config', configRoutes);
  // Build identity. The ONLY unauthenticated non-/share/* route in the app:
  // trade-off in full, and tests/share-boundary.test.ts holds the matching
  // allowlist entry — a second public route means editing a security test.
  apiR.route('/version', versionRoutes);
  // enforced first here by conditional REGISTRATION — mirrors the local-session

  // is read live INSIDE createApp()'s own function body (not the module-scope
  // router has no handler and no OpenAPI path for /llm-connections/*: a
  // handler inside llmConnectionRoutes ALSO re-checks env().localMode live
  // (the second half of the two-part enforcement) — see that file's header.
  if (env().localMode) {
    apiR.route('/llm-connections', llmConnectionRoutes);
  }
  apiR.route('/auth/invites', inviteRoutes);
  // Public and unauthenticated by design: the landing page's invite-request
  // form. Self-gated on INVITE_REQUESTS_ENABLED / local mode and rate-limited
  // per client IP; registered with plain .post(), so it is not in the OpenAPI
  // document the share-boundary sweep reads.
  apiR.route('/invite-requests', inviteRequestRoutes);
  // DV-11: built fresh on every createApp() call so the local-session route's

  apiR.route('/auth', buildAuthRoutes());
  // shareCrudRoutes carries its own `requireJwtAuth` per-route middleware (D-13: PAT
  // ensures the global gate never interferes with per-route auth semantics.
  apiR.route('/shares', shareCrudRoutes);

  // never interacts with the /universes/* auth block below.
  apiR.use('/sync/*', requireAuth);
  apiR.route('/sync', syncRoutes);


  // requireJwtAuth on top of the /sync/* requireAuth gate (D-10).
  apiR.route('/sync', syncClientRoutes);
  apiR.use('/universes/*', requireAuth);
  // /api/audits/in-flight. requireAuth gates the bearerAuth contract.
  apiR.use('/audits/*', requireAuth);
  apiR.route('/audits', auditCrossUniverseRoutes);
  apiR.route('/universes/import', importRoutes);
  // 11-03: mount /universes/:uid/ingest BEFORE the bare /universes mount so
  // the more-specific path wins, mirroring the /universes/import precedence.
  apiR.route('/universes/:uid/ingest', ingestRoutes);
  apiR.route('/universes', universeRoutes);
  apiR.route('/universes/:uid/entries', entryRoutes);
  apiR.route('/universes/:uid/entries', timelinePinRoutes);
  apiR.route('/universes/:uid/links', linkRoutes);
  apiR.route('/universes/:uid/relations', relationRoutes);
  apiR.route('/universes/:uid/link-types', linkTypeRoutes);
  apiR.route('/universes/:uid/categories', categoryRoutes);
  apiR.route('/universes/:uid/issues', issueRoutes);
  apiR.route('/universes/:uid', auditRoutes);
  // GET /api/universes/:id/stats (distinct sub-path — no collision with the bare
  apiR.route('/universes', statsRoutes);
  apiR.route('/universes/:uid/diagrams', diagramsRouter);
  apiR.route('/universes/:uid/maps', mapsRouter);
  apiR.route('/universes/:uid/map-layers', mapLayersRouter);
  apiR.route('/universes/:uid/assets', assetsRouter);
  // PAT parity (T-32-06) and share-boundary coverage (T-32-07) come for free.
  apiR.route('/universes/:uid/dictionary', dictionaryRoutes);
  apiR.route('/universes/:uid/graph-data', graphRoutes);
  apiR.route('/universes/:uid/graph-positions', graphPositionRoutes);
  apiR.route('/universes/:uid/export', exportRoutes);
  apiR.route('/universes/:uid', timelineListRoutes);
  // share requests; the share-token credential domain stays strictly separate from
  // the JWT/PAT bearer domain (T-29-04 elevation-of-privilege mitigation). The
  // the URL contract per D-02.
  app.route('/api/runtime', buildRuntimeRoutes());
  app.route('/api/share', shareRoutes);
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

  const webDist = cfg.webDist;
  app.use('*', serveStatic({ root: webDist }));
  app.get('/', serveStatic({ path: `${webDist}/index.html` }));
  app.get('*', serveStatic({ path: `${webDist}/index.html` }));

  app.onError((err, c) => {
    if (isSharedLlmPath(c.req.path)) {
      if (err instanceof HTTPException) {
        const mapped = sharedLlmErrorResponse(err);
        return c.json(mapped.body, mapped.status);
      }
      const errText = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(scrubLogLine(errText));
      return c.json({ error: 'Shared connection is temporarily unavailable', code: 'shared_connection_unavailable' }, 503);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    // WR-07 fix: scrub the error stack/message through the same redaction
    const errText = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(scrubLogLine(errText));
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}

export const app = createApp();

export async function assertLlmKeyEncryptionKey(deps: {
  db: ReturnType<typeof db>;
  cfg: Env;
}): Promise<void> {
  if (deps.cfg.llmKeyEncryptionKey) return;
  const hasKeys = await deps.db.select({ id: llmApiKeys.id }).from(llmApiKeys).limit(1);
  const hasRemotes = await deps.db.select({ id: syncRemotes.id }).from(syncRemotes).limit(1);
  if (hasKeys.length > 0 || hasRemotes.length > 0) {
    throw new Error(
      'LLM_KEY_ENCRYPTION_KEY must be set when llm_api_keys or sync_remotes rows exist ' +
      '(sync_remotes.encrypted_pat uses the same key). ' +
      'See README ## Self-Host for the backup callout (the key is unrecoverable if lost). ' +
      'Generate one with: openssl rand -hex 32'
    );
  }
}

// Re-exported so the Electron main process can close the SAME
// re-deriving a path to db/client.js and importing that. WELTBON_API_ENTRY
// second, independently-constructed path to db/client.js is not guaranteed
// doesn't, Node's module cache treats it as a distinct, never-initialized
// module instance whose closeDb() would be a silent no-op.
export { closeDb };

export async function startServer(): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  if (!cfg.publicOrigin) {
    console.warn(
      '[weltbon] WELTBON_PUBLIC_ORIGIN is not set — CORS will reflect any Origin with credentials. ' +
      'This is acceptable for local dev. For production, set WELTBON_PUBLIC_ORIGIN=https://your.domain ' +
      'to restrict CORS to your operator-controlled origin.'
    );
  }
  await initDb();
  await runMigrations(db());
  await seedInviteCode(db());
  await assertLlmKeyEncryptionKey({ db: db(), cfg });
  // AUDIT-12: force-fail any pending|running orphan runs from a previous process.
  // Runs BEFORE serve() so no inbound HTTP can race the UPDATE (T-24-06-04).
  // Failure logs a warning but does NOT crash the API (T-24-06-05).
  try {
    await recoverOrphanAuditRuns(db());
  } catch (err) {
    console.warn('[audit-recovery] failed at boot; orphan rows may persist:', err);
  }
  // which both hides #42's first-sync-failed banner and blocks a manual retry
  try {
    await recoverOrphanSyncLinks(db());
  } catch (err) {
    console.warn('[sync-recovery] failed at boot; interrupted links may persist:', err);
  }

  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.bindHost });
  const port = await new Promise<number>((resolve, reject) => {
    const read = () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('server bound to a non-TCP address'));
    };
    const addr = server.address();
    if (addr) read();
    else server.once('listening', read);
  });

  // #44 (AS-07): auto-sync. Started HERE and only here — after serve(), never
  const autoSync = cfg.autoSyncEnabled ? createScheduler() : null;
  autoSync?.start();

  // more than once in a process — tests/start-server.test.ts boots three
  const stopAutoSyncOnSigterm = () => autoSync?.stop();
  process.once('SIGTERM', stopAutoSyncOnSigterm);

  server.on('close', () => {
    autoSync?.stop();
    process.off('SIGTERM', stopAutoSyncOnSigterm);
  });

  // D-04: register SIGTERM handler after serve() so the handler has the server reference.
  wireSigtermDrain(server, cfg.auditShutdownGraceMs);
  console.log(`Weltbon API listening on :${port}`);
  return { server, port };
}

// is load-bearing: a packaged Electron app imports this module with no script
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  await startServer();
}
