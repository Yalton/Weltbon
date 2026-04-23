import { Hono } from 'hono';
import { importUniverseJson } from '../services/import-json.js';
import type { AuthVariables } from '../middleware/auth.js';
import { ZodError } from 'zod';

export const importRoutes = new Hono<{ Variables: AuthVariables }>()
  .post('/', async (c) => {
    const userId = c.var.userId;
    const rawBody = await c.req.json();
    try {
      const result = await importUniverseJson(userId, rawBody);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues as Array<{ path: Array<string | number>; message: string }>;
        const versionError = issues.find((e) => e.path.includes('weltbon_version'));
        if (versionError) {
          return c.json({ error: 'Incompatible export version. Expected 1.0.0' }, 400);
        }
        return c.json({ error: 'Invalid import format', details: issues }, 400);
      }
      if (err instanceof Error && err.message.includes('unknown entry ID')) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });
