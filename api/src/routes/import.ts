import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { importUniverseJson, importSchema } from '../services/import-json.js';
import type { AuthVariables } from '../middleware/auth.js';
import { ZodError } from 'zod';

type AppEnv = { Variables: AuthVariables };

// ─── Response schemas ────────────────────────────────────────────────────────

const importResultSchema = z.object({
  universeId: z.string(),
  universeName: z.string(),
  entryCount: z.number(),
  linkCount: z.number(),
  categoryCount: z.number(),
  issueCount: z.number(),
  positionCount: z.number(),
  pinCount: z.number(),
});

const errorSchema = z.object({ error: z.string() });

// ─── Route definitions ───────────────────────────────────────────────────────

const importRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Import'],
  summary: 'Import a universe from JSON',
  description: 'Creates a new universe from a Weltbon export JSON file. Remaps all IDs. Version must be 1.0.0.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: importSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: importResultSchema,
        },
      },
      description: 'Universe imported successfully',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid import format, incompatible version, or unknown referenced IDs',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error (transactional failure)',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const importRoutes = new OpenAPIHono<AppEnv>()

  .openapi(importRoute, async (c) => {
    const userId = c.var.userId;
    const rawBody = c.req.valid('json');
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
        return c.json({ error: 'Invalid import format', details: issues } as any, 400);
      }
      if (err instanceof Error && err.message.includes('unknown entry ID')) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });
