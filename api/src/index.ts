import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { env } from './config.js';
import { authRoutes } from './routes/auth.js';
import { tokenRoutes } from './routes/tokens.js';
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
import { db } from './db/client.js';
import { seedInviteCode } from './db/seedInviteCode.js';
import { createApiRouter } from './openapi/app.js';
import { scalarHtml } from './openapi/scalar.js';

const cfg = env();

export function createApp() {
  const app = new Hono();
  app.use('*', logger((msg) => {
    console.log(msg.replace(/(authorization|cookie):\s*[^\n]+/gi, '$1: [redacted]'));
  }));
  app.use('*', cors({
    origin: (origin) => origin,
    credentials: true,
  }));
  const apiR = createApiRouter();
  apiR.route('/auth/tokens', tokenRoutes);
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
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}

export const app = createApp();

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedInviteCode(db());
  serve({ fetch: app.fetch, port: cfg.port });
  console.log(`Weltbon API listening on :${cfg.port}`);
}
