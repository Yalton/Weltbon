import { Hono } from 'hono';
import { requireUniverse } from '../utils/ownership.js';
import { exportUniverseJson } from '../services/export-json.js';
import type { AuthVariables } from '../middleware/auth.js';

export const exportRoutes = new Hono<{ Variables: AuthVariables }>()
  .get('/', async (c) => {
    const uid = c.req.param('uid')!;
    const userId = c.var.userId;
    const universe = await requireUniverse(uid, userId);

    const format = c.req.query('format') || 'json';
    if (format !== 'json') {
      return c.json({ error: `Unsupported format: ${format}` }, 400);
    }

    const data = await exportUniverseJson(uid);
    const filename = `${universe.name.replace(/[^a-zA-Z0-9\-_ ]/g, '')}.json`;
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.json(data);
  });
