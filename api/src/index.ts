import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { HTTPException } from 'hono/http-exception';
import { env } from './config.js';
import { authRoutes } from './routes/auth.js';

// Touching env() on module load enforces the startup guard (AUTH-05a/b, OPS-04).
const cfg = env();

export function createApp() {
  const app = new Hono();
  app.use('*', logger((msg) => {
    // Strip Authorization and Cookie headers from log line (PITFALLS Pitfall 6)
    console.log(msg.replace(/(authorization|cookie):\s*[^\n]+/gi, '$1: [redacted]'));
  }));
  app.use('*', cors({
    origin: (origin) => origin, // reflect -- LAN deployment; tighten in production
    credentials: true,
  }));
  app.route('/auth', authRoutes);
  app.get('/health', (c) => c.json({ ok: true }));

  // Consistent JSON error responses
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

// Only start the server when executed directly (not during tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  serve({ fetch: app.fetch, port: cfg.port });
  console.log(`Weltbon API listening on :${cfg.port}`);
}
