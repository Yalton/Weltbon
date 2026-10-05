import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { inviteCodes } from '../db/schema.js';
import { requireAdmin, type AuthVariables } from '../middleware/auth.js';
import { createInviteCode } from '../services/invite.js';
import { isUniqueViolation } from '../db/pg-error.js';

type AppEnv = { Variables: AuthVariables };


const createSchema = z.object({
  label: z.string().trim().min(1, 'Label is required').max(100),
});

const inviteResponseSchema = z.object({
  id: z.string(),
  label: z.string(),
  bodySuffix: z.string(),
  createdAt: z.string(),
  plaintext: z.string(),
});

const inviteListItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  bodySuffix: z.string(),
  createdAt: z.string(),
  usedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  usedBy: z.object({ displayName: z.string(), email: z.string() }).nullable(),
});

const errorSchema = z.object({ error: z.string() });


const postRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Invite Codes'],
  summary: 'Mint a new invite code',
  description: 'Creates a new invite code. Administrator JWT required.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireAdmin] as const,
  request: {
    body: {
      content: { 'application/json': { schema: createSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: inviteResponseSchema } },
      description: 'Invite code created; plaintext shown exactly once',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Validation error',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT bearer token',
    },
    409: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Hash collision; retry',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Invite Codes'],
  summary: 'List invite codes for the authenticated user',
  description:
    'Returns invite codes owned by calling user. owner_id = userId filter excludes bootstrap row (D-INV-12).',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(inviteListItemSchema) } },
      description: 'Array of invite code metadata',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Invite Codes'],
  summary: 'Revoke an invite code by ID',
  description: 'Soft-revoke (sets revokedAt) on the invite if active and owned by caller.',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireAdmin] as const,
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    204: { description: 'Invite revoked successfully' },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid JWT',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invite not found, not owned by caller, or already used/revoked',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});


export const inviteRoutes = new OpenAPIHono<AppEnv>()

  .openapi(postRoute, async (c) => {
    const userId = c.var.userId;
    const { label } = c.req.valid('json');
    try {
      return c.json(await createInviteCode(getDb(), userId, label), 200);
    } catch (err: any) {
      if (isUniqueViolation(err)) {
        return c.json({ error: 'Invite code collision, please retry' }, 409);
      }
      throw err;
    }
  })

  .openapi(getRoute, async (c) => {
    const userId = c.var.userId;
    const rows = await getDb().query.inviteCodes.findMany({
      where: eq(inviteCodes.ownerId, userId),
      columns: {
        id: true,
        label: true,
        bodySuffix: true,
        createdAt: true,
        usedAt: true,
        revokedAt: true,
      },
      with: { consumedBy: { columns: { displayName: true, email: true } } },
      orderBy: [desc(inviteCodes.createdAt)],
    });
    return c.json(
      rows.map((r) => ({
        id: r.id,
        label: r.label,
        bodySuffix: r.bodySuffix,
        createdAt: r.createdAt.toISOString(),
        usedAt: r.usedAt ? r.usedAt.toISOString() : null,
        revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
        usedBy: r.consumedBy ?? null,
      })),
      200
    );
  })

  .openapi(deleteRoute, async (c) => {
    const userId = c.var.userId;
    const id = c.req.valid('param').id;
    const updated = await getDb()
      .update(inviteCodes)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(inviteCodes.id, id),
          eq(inviteCodes.ownerId, userId),
          isNull(inviteCodes.revokedAt),
          isNull(inviteCodes.usedAt)
        )
      )
      .returning({ id: inviteCodes.id });
    if (updated.length === 0) {
      return c.json({ error: 'Invite code not found' }, 404);
    }
    return c.body(null, 204);
  });
