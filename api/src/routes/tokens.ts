import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import { generatePatToken } from '../services/pat.js';
import { isUniqueViolation } from '../db/pg-error.js';

type AppEnv = { Variables: AuthVariables };


const createSchema = z.object({
  label: z.string().trim().max(100).default(''),
});

const tokenResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
  bodySuffix: z.string(),
  createdAt: z.string(),
  plaintext: z.string(),
});

const tokenListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  bodySuffix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

const errorSchema = z.object({
  error: z.string(),
});


const postRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Personal Access Tokens'],
  summary: 'Mint a new PAT',
  description: 'Creates a new Personal Access Token. JWT auth required (D-13: PAT cannot mint other PATs).',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: createSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: tokenResponseSchema,
        },
      },
      description: 'PAT created; plaintext shown exactly once',
    },
    400: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'Validation error (e.g. label too long)',
    },
    401: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'Missing or invalid JWT bearer token',
    },
    409: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'Token hash collision (extremely rare); retry',
    },
    500: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'Internal error',
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Personal Access Tokens'],
  summary: 'List PATs for the authenticated user',
  description: 'Returns all PATs belonging to the calling user. Hash and plaintext are never returned. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.array(tokenListItemSchema),
        },
      },
      description: 'Array of PAT metadata (no hash, no plaintext)',
    },
    401: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'Missing or invalid JWT bearer token',
    },
    500: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'Internal error',
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Personal Access Tokens'],
  summary: 'Revoke a PAT by ID',
  description: 'Deletes the PAT with the given ID if it belongs to the authenticated user. JWT auth required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    204: {
      description: 'PAT deleted successfully',
    },
    401: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'Missing or invalid JWT bearer token',
    },
    404: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'PAT not found (not owned by caller or does not exist)',
    },
    500: {
      content: {
        'application/json': {
          schema: errorSchema,
        },
      },
      description: 'Internal error',
    },
  },
});


export const tokenRoutes = new OpenAPIHono<AppEnv>()

  .openapi(postRoute, async (c) => {
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
      return c.json({ ...row, plaintext, createdAt: row.createdAt.toISOString() }, 200);
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        return c.json({ error: 'Token collision, please retry' }, 409);
      }
      throw err;
    }
  })

  .openapi(getRoute, async (c) => {
    const userId = c.var.userId;
    const rows = await getDb().query.personalAccessTokens.findMany({
      where: eq(personalAccessTokens.userId, userId),
      columns: { id: true, label: true, bodySuffix: true, createdAt: true, lastUsedAt: true },
      orderBy: [desc(personalAccessTokens.createdAt)],
    });
    return c.json(
      rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      })),
      200
    );
  })

  .openapi(deleteRoute, async (c) => {
    const userId = c.var.userId;
    const id = c.req.valid('param').id;
    const deleted = await getDb()
      .delete(personalAccessTokens)
      .where(and(eq(personalAccessTokens.id, id), eq(personalAccessTokens.userId, userId)))
      .returning({ id: personalAccessTokens.id });
    if (deleted.length === 0) {
      return c.json({ error: 'Token not found' }, 404);
    }
    return c.body(null, 204);
  });
