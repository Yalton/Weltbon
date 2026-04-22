import { Hono } from 'hono';

/**
 * Auth routes — placeholder for Plan 01-02.
 * Plan 01-02 provides: POST /register, POST /login, POST /refresh, POST /logout.
 * This minimal export satisfies the app.route('/auth', authRoutes) mount.
 */
export const authRoutes = new Hono()
  .get('/health', (c) => c.json({ auth: 'ok' }));
