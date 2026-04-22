import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { env } from './config.js';
import { authRoutes } from './routes/auth.js';
import { universeRoutes } from './routes/universes.js';
import { requireAuth } from './middleware/auth.js';

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
  app.route('/universes', universeRoutes);

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

// Start server only when run directly (not when imported by tests)
const isDirectRun =
  process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.endsWith('index.js');

if (isDirectRun) {
  const { port } = env();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Weltbon API listening on port ${info.port}`);
  });
}
