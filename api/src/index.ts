import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { env } from './config.js';
import { authRoutes } from './routes/auth.js';
import { universeRoutes } from './routes/universes.js';
import { entryRoutes } from './routes/entries.js';
import { linkRoutes, relationRoutes } from './routes/links.js';
import { categoryRoutes } from './routes/categories.js';
import { issueRoutes } from './routes/issues.js';
import { graphRoutes, graphPositionRoutes } from './routes/graph.js';
import { exportRoutes } from './routes/export.js';
import { importRoutes } from './routes/import.js';
import { timelinePinRoutes, timelineListRoutes } from './routes/timeline.js';
import { requireAuth } from './middleware/auth.js';

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
  app.route('/auth', authRoutes);
  app.use('/universes/*', requireAuth);
  app.route('/universes/import', importRoutes);
  app.route('/universes', universeRoutes);
  app.route('/universes/:uid/entries', entryRoutes);
  app.route('/universes/:uid/entries', timelinePinRoutes);
  app.route('/universes/:uid/links', linkRoutes);
  app.route('/universes/:uid/relations', relationRoutes);
  app.route('/universes/:uid/categories', categoryRoutes);
  app.route('/universes/:uid/issues', issueRoutes);
  app.route('/universes/:uid/graph-data', graphRoutes);
  app.route('/universes/:uid/graph-positions', graphPositionRoutes);
  app.route('/universes/:uid/export', exportRoutes);
  app.route('/universes/:uid', timelineListRoutes);
  app.get('/health', (c) => c.json({ ok: true }));

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
  serve({ fetch: app.fetch, port: cfg.port });
  console.log(`Weltbon API listening on :${cfg.port}`);
}
