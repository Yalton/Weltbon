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
// Phase 29 D-02 — share-CRUD owner-facing router (JWT-only via per-route requireJwtAuth)
import { shareCrudRoutes } from './routes/shares.js';
// Phase 29 SHARE-02/03 — visitor share-read router (share-token via per-route requireShareToken)
import { shareRoutes } from './routes/share.js';
import { llmKeyRoutes } from './routes/llm-keys.js';
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
 *   - wbn_share_* tokens (Phase 29 — share-link plaintext URLs)
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
  apiR.route('/templates', templates);
  apiR.route('/llm-keys', llmKeyRoutes);
  // Phase 27 Plan 03 Task 2 — GET /api/llm/models?provider= (model-catalog cache).
  // Mounted at the bare /api prefix; the createRoute path '/llm/models' resolves
  // to the full /api/llm/models URL. JWT-only via the route's own requireJwtAuth
  // middleware — no apiR.use() needed (mirrors llmKeyRoutes' per-route gate).
  apiR.route('/', llmModelsRoutes);
  // Issue #48 Task 6: GET /api/config is UNCONDITIONAL (mounted on hosted and
  // desktop alike) but NOT unauthenticated — routes/config.ts gates it with
  // `requireAuth`, deliberately, so a share-token-only request cannot reach it
  // (SHARE-03 / T-29-22). The frontend reads `localMode` from it after login,
  // to decide which settings sections exist at all.
  apiR.route('/config', configRoutes);
  // Build identity. The ONLY unauthenticated non-/share/* route in the app:
  // `curl <host>/api/version` is how a deploy is confirmed, and a deploy script
  // has no user to authenticate as. routes/version.ts carries the disclosure
  // trade-off in full, and tests/share-boundary.test.ts holds the matching
  // allowlist entry — a second public route means editing a security test.
  apiR.route('/version', versionRoutes);
  // Issue #48 Task 6: llm-connections (Ollama endpoint config) is DESKTOP-ONLY,
  // enforced first here by conditional REGISTRATION — mirrors the local-session
  // route's DV-11 / "Finding 2 review fix" pattern in routes/auth.ts. `env()`
  // is read live INSIDE createApp()'s own function body (not the module-scope
  // `cfg` above, which is captured once at first import) so a test that flips
  // WELTBON_LOCAL_MODE and calls createApp() again sees the change — same
  // reasoning as buildAuthRoutes() below. When this branch does not run, the
  // router has no handler and no OpenAPI path for /llm-connections/*: a
  // hosted deployment's /api/openapi.json and /api/docs never mention it, and
  // a probing request 404s exactly like any other unmounted route. Every
  // handler inside llmConnectionRoutes ALSO re-checks env().localMode live
  // (the second half of the two-part enforcement) — see that file's header.
  if (env().localMode) {
    apiR.route('/llm-connections', llmConnectionRoutes);
  }
  apiR.route('/auth/invites', inviteRoutes);
  // DV-11: built fresh on every createApp() call so the local-session route's
  // conditional registration (Finding 2 review fix) sees a live env().localMode
  // read, not whatever it was the first time this module was ever imported.
  apiR.route('/auth', buildAuthRoutes());
  // Phase 29 D-02 / D-13 — owner-facing share CRUD (POST mint, GET list, PATCH rename,
  // DELETE revoke). Mounted BEFORE the `requireAuth` gate below because each route in
  // shareCrudRoutes carries its own `requireJwtAuth` per-route middleware (D-13: PAT
  // cannot mint or revoke share tokens). Keeping it outside the global `requireAuth`
  // ensures the global gate never interferes with per-route auth semantics.
  apiR.route('/shares', shareCrudRoutes);
  // Plan C (sync spec "Protocol"): the peer-facing sync surface, PAT-or-JWT
  // authenticated. Mounted at its own /sync prefix with its own gate so it
  // never interacts with the /universes/* auth block below.
  apiR.use('/sync/*', requireAuth);
  apiR.route('/sync', syncRoutes);
  // Plan D: the owner-facing half at the SAME prefix, from its own file so the
  // peer surface above stays seven routes (Plan C's six plus A-04's discovery
  // route). Each route here adds
  // requireJwtAuth on top of the /sync/* requireAuth gate (D-10).
  apiR.route('/sync', syncClientRoutes);
  apiR.use('/universes/*', requireAuth);
  // Phase 26 Plan 03 — D-06 cross-universe in-flight rollup.
  // Mounted at root /api prefix (NOT under /universes/:uid) because it
  // operates across ALL of the authed user's universes. Full path:
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
  // Phase 35 REL-01: link-type autocomplete (mounted after relations, before categories)
  apiR.route('/universes/:uid/link-types', linkTypeRoutes);
  apiR.route('/universes/:uid/categories', categoryRoutes);
  apiR.route('/universes/:uid/issues', issueRoutes);
  apiR.route('/universes/:uid', auditRoutes);
  // Phase 36 DATA-05: universe statistics aggregate. The route's internal path is
  // '/{id}/stats', so mounting at the bare '/universes' prefix resolves it to
  // GET /api/universes/:id/stats (distinct sub-path — no collision with the bare
  // /universes universeRoutes mount above). requireAuth already applies via
  // apiR.use('/universes/*', requireAuth) at the top of this block.
  apiR.route('/universes', statsRoutes);
  apiR.route('/universes/:uid/diagrams', diagramsRouter);
  // Phase 39 MAPS-01/02/03: per-universe image-backed maps + entry-linked pins.
  // requireAuth already applies via apiR.use('/universes/*', requireAuth) above.
  apiR.route('/universes/:uid/maps', mapsRouter);
  // Phase 42 LAYER-01/02/03: per-universe map layer + terrain-type CRUD.
  // requireAuth already applies via apiR.use('/universes/*', requireAuth) above.
  apiR.route('/universes/:uid/map-layers', mapLayersRouter);
  // Phase 38 MEDIA-01/02/03/04: per-universe image asset upload/serving/CRUD.
  // requireAuth already applies via apiR.use('/universes/*', requireAuth) above.
  apiR.route('/universes/:uid/assets', assetsRouter);
  // Phase 32 CONLANG-01/02: dictionary CRUD + FTS + CSV import.
  // requireAuth already applies via apiR.use('/universes/*', requireAuth) at ln 104 —
  // PAT parity (T-32-06) and share-boundary coverage (T-32-07) come for free.
  apiR.route('/universes/:uid/dictionary', dictionaryRoutes);
  apiR.route('/universes/:uid/graph-data', graphRoutes);
  apiR.route('/universes/:uid/graph-positions', graphPositionRoutes);
  apiR.route('/universes/:uid/export', exportRoutes);
  apiR.route('/universes/:uid', timelineListRoutes);
  // Phase 29 D-02 / T-29-20 / SHARE-03 — visitor read namespace mounted on `app`
  // (a SIBLING of `apiR`), so requests to `/api/share/*` NEVER traverse the apiR
  // mount tree at all. The `apiR.use('/universes/*', requireAuth)` gate never sees
  // share requests; the share-token credential domain stays strictly separate from
  // the JWT/PAT bearer domain (T-29-04 elevation-of-privilege mitigation). The
  // singular `/api/share` (read) vs plural `/api/shares` (CRUD) namespace split is
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

  // Resolved from config so a second caller (the Electron main process, which
  // runs with a completely different cwd) can point at its packaged copy.
  // Relative values still resolve against process.cwd(), preserving the exact
  // previous behaviour for every existing deployment.
  const webDist = cfg.webDist;
  app.use('*', serveStatic({ root: webDist }));
  app.get('/', serveStatic({ path: `${webDist}/index.html` }));
  app.get('*', serveStatic({ path: `${webDist}/index.html` }));

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
 * Aborts startup if EITHER llm_api_keys OR sync_remotes has any rows but
 * `LLM_KEY_ENCRYPTION_KEY` is unset. Both tables encrypt at rest under the
 * SAME key (sync_remotes.encrypted_pat — see routes/sync-client.ts's own
 * docstring), so a key lost or unset covers both silently until the first use:
 * an audit run 503s, or a sync run throws SyncRemoteKeyError at the first
 * /links/{id}/run. This check exists so that failure surfaces at boot, not at
 * the first attempted sync. Exported as a callable function so Plan 22-04's
 * (and now Plan D's) behavioral tests can exercise the throw path directly
 * with a stubbed db + empty cfg, instead of relying on a grep gate.
 *
 * Semantics (either table counts identically):
 *   - rows=0 + key unset → no-op (operator hasn't enabled BYOK / sync yet)
 *   - rows=0 + key set → no-op (key present, no rows yet — fine)
 *   - rows>0 + key set → no-op (normal operation)
 *   - rows>0 + key unset → throw (would silently 503/500 at first use; LLMKEY-08 violation)
 */
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

// Re-exported so the Electron main process (Stage 2) can close the SAME
// PGlite handle this module's own boot sequence opened. main.ts already
// dynamically imports this compiled file by URL to get `startServer` — it
// must pull `closeDb` off that SAME import result rather than separately
// re-deriving a path to db/client.js and importing that. WELTBON_API_ENTRY
// lets an operator point apiEntry somewhere other than the conventional
// <apiRoot>/dist/index.js (see the DRIZZLE_DIR comment in main.ts), so a
// second, independently-constructed path to db/client.js is not guaranteed
// to resolve to the identical file this module actually imported — and if it
// doesn't, Node's module cache treats it as a distinct, never-initialized
// module instance whose closeDb() would be a silent no-op.
export { closeDb };

/**
 * The full boot sequence, callable. Extracted so the Electron main process
 * (Stage 2) can start the same server the CLI entrypoint does, instead of
 * duplicating this ordering and letting the two copies drift.
 *
 * Resolves only once the socket is listening, and reports the port that was
 * ACTUALLY bound — with PORT=0 the kernel picks it, and the caller needs the
 * real number to build the URL it loads.
 *
 * DV-04: PGlite is constructed asynchronously, so the handle must exist
 * before ANY db() call below. On the postgres driver this is a no-op that
 * moves pool construction LATER, not earlier: on master, client.ts built
 * the pool at module load time (`const defaultPool = new pg.Pool(...)`);
 * this branch moves construction into this boot block instead, so on
 * Postgres `initDb()` makes it happen here rather than at import time.
 * Still harmless either way — constructing a pg.Pool does no I/O, and this
 * call is before serve() regardless.
 */
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
  // Issue #55: the same orphan problem for sync links. A run interrupted
  // between claimLink() and safeRelease() leaves the row 'syncing' forever,
  // which both hides #42's first-sync-failed banner and blocks a manual retry
  // with SyncBusyError for a full lease period. Same placement rationale as
  // above: BEFORE serve(), so no inbound HTTP races the UPDATE, and a failure
  // warns rather than crashing the API.
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
  // at app construction — because the api integration lane builds the app
  // dozens of times per run and a background timer ticking inside those builds
  // would sync real links out from under the test that owns the database.
  // Unlike recoverOrphanSyncLinks above, which must finish BEFORE serve() so no
  // inbound HTTP races its UPDATE, this one has nothing to race.
  const autoSync = cfg.autoSyncEnabled ? createScheduler() : null;
  autoSync?.start();

  // Registered BEFORE wireSigtermDrain so it runs first: Node fires SIGTERM
  // listeners in registration order, and the drain's handler ends in
  // process.exit(). Stopping the timer before the server drains means no tick
  // can start a fresh sync run into a process that is on its way out.
  //
  // `once` plus the explicit removal below because startServer() is callable
  // more than once in a process — tests/start-server.test.ts boots three
  // times, Electron boots on demand — and a listener added per boot and never
  // removed is a MaxListenersExceededWarning waiting for the eleventh caller.
  const stopAutoSyncOnSigterm = () => autoSync?.stop();
  process.once('SIGTERM', stopAutoSyncOnSigterm);

  // The scheduler's lifetime IS the server's. Without this, any caller that
  // shuts down by closing the server rather than by SIGTERM — every test that
  // boots startServer(), and Electron's own teardown — leaves a live interval
  // behind that goes on querying a database somebody else has already closed.
  server.on('close', () => {
    autoSync?.stop();
    process.off('SIGTERM', stopAutoSyncOnSigterm);
  });

  // D-04: register SIGTERM handler after serve() so the handler has the server reference.
  wireSigtermDrain(server, cfg.auditShutdownGraceMs);
  console.log(`Weltbon API listening on :${port}`);
  return { server, port };
}

// See the identical guard in db/migrate.ts for why the `!== undefined` check
// is load-bearing: a packaged Electron app imports this module with no script
// argument, so `process.argv[1]` is undefined and pathToFileURL(undefined)
// throws. Electron calls startServer() itself, so this branch must simply not
// fire there — quietly, not by crashing.
const entryArg = process.argv[1];
if (entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href) {
  await startServer();
}
