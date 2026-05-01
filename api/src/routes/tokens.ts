import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import { generatePatToken } from '../services/pat.js';

const createSchema = z.object({
  label: z.string().trim().max(100).default(''),
});

export const tokenRoutes = new Hono<{ Variables: AuthVariables }>()
  .use('*', requireJwtAuth) // D-13: PAT meta-API is JWT-only

  .post('/', zValidator('json', createSchema), async (c) => {
    const userId = c.var.userId;
    const { label } = c.req.valid('json');
    const { plaintext, hash, bodySuffix } = generatePatToken();
    try {
      const [row] = await getDb()
        .insert(personalAccessTokens)
        .values({ userId, label, hash, bodySuffix })
        .returning({
          id: personalAccessTokens.id,
          label: personalAccessTokens.label,
          bodySuffix: personalAccessTokens.bodySuffix,
          createdAt: personalAccessTokens.createdAt,
        });
      return c.json({ ...row, plaintext }, 200);
    } catch (err: any) {
      if (err?.code === '23505') {
        return c.json({ error: 'Token collision, please retry' }, 409);
      }
      throw err;
    }
  })

  .get('/', async (c) => {
    const userId = c.var.userId;
    const rows = await getDb().query.personalAccessTokens.findMany({
      where: eq(personalAccessTokens.userId, userId),
      columns: { id: true, label: true, bodySuffix: true, createdAt: true, lastUsedAt: true },
      orderBy: [desc(personalAccessTokens.createdAt)],
    });
    return c.json(rows, 200);
  })

  .delete('/:id', async (c) => {
    const userId = c.var.userId;
    const id = c.req.param('id');
    const deleted = await getDb()
      .delete(personalAccessTokens)
      .where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, userId)))
      .returning({ id: personalAccessTokens.id });
    if (deleted.length === 0) {
      return c.json({ error: 'Token not found' }, 404);
    }
    return c.body(null, 204);
  });
