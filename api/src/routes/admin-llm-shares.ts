import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireAdmin, type AuthVariables } from '../middleware/auth.js';
import {
  createSharedGrant,
  getAdminSharedGrant,
  listAdminSharedGrants,
  revokeSharedGrant,
  SHARED_PROVIDER_NAMES,
  SharedLlmError,
  type SharedAdminGrantView,
} from '../services/llm-sharing.js';

type AppEnv = { Variables: AuthVariables };

const errorSchema = z.object({ error: z.string(), code: z.string() });
const idParams = z.object({ id: z.string().uuid() });
const createBody = z.object({
  recipientUserId: z.string().uuid(),
  provider: z.enum(SHARED_PROVIDER_NAMES),
}).strict();
const usageSchema = z.object({
  monthStart: z.string(),
  settledUsd: z.string(),
  reservedUsd: z.string(),
  limitUsd: z.string(),
  activeAudits: z.number().int(),
  maxConcurrentAudits: z.literal(1),
  completedAudits: z.number().int(),
  failedAudits: z.number().int(),
});
const accountSchema = z.object({ id: z.string().uuid(), displayName: z.string(), email: z.string().email() });
const adminGrantSchema = z.object({
  id: z.string().uuid(),
  owner: accountSchema,
  recipient: accountSchema,
  provider: z.enum(SHARED_PROVIDER_NAMES),
  status: z.enum(['active', 'revoked']),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  revokedReason: z.string().nullable(),
  consentedAt: z.string().datetime().nullable(),
  usage: usageSchema,
});

function adminGrant(view: SharedAdminGrantView) {
  return {
    id: view.id,
    owner: { id: view.owner.id, displayName: view.owner.displayName, email: view.owner.email },
    recipient: { id: view.recipient.id, displayName: view.recipient.displayName, email: view.recipient.email },
    provider: view.provider,
    status: view.status,
    createdAt: view.createdAt.toISOString(),
    revokedAt: view.revokedAt?.toISOString() ?? null,
    revokedReason: view.revokedReason,
    consentedAt: view.consentedAt?.toISOString() ?? null,
    usage: {
      monthStart: view.usage.monthStart,
      settledUsd: view.usage.settledUsd,
      reservedUsd: view.usage.reservedUsd,
      limitUsd: view.usage.limitUsd,
      activeAudits: view.usage.activeAudits,
      maxConcurrentAudits: view.usage.maxConcurrentAudits,
      completedAudits: view.usage.completedAudits,
      failedAudits: view.usage.failedAudits,
    },
  };
}

function sharedError(error: unknown): { status: 400 | 403 | 404 | 409 | 503; body: { error: string; code: string } } | null {
  if (!(error instanceof SharedLlmError)) return null;
  switch (error.code) {
    case 'shared_admin_required':
      return { status: 403, body: { error: 'Administrator access is required', code: error.code } };
    case 'shared_connection_not_found':
      return { status: 404, body: { error: 'Shared connection not found', code: error.code } };
    case 'shared_connection_exists':
      return { status: 409, body: { error: 'An active shared connection already exists', code: error.code } };
    case 'shared_recipient_invalid':
      return { status: 400, body: { error: 'Recipient cannot be the grant owner', code: error.code } };
    case 'shared_recipient_unavailable':
      return { status: 400, body: { error: 'Recipient is unavailable', code: error.code } };
    case 'shared_provider_unsupported':
    case 'shared_revocation_reason_invalid':
      return { status: 400, body: { error: 'Invalid shared connection request', code: error.code } };
    case 'owner_key_required':
      return { status: 503, body: { error: 'Administrator hosted key is unavailable', code: error.code } };
    default:
      return { status: 503, body: { error: 'Shared connection is temporarily unavailable', code: 'shared_connection_unavailable' } };
  }
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Administration'],
  summary: 'List shared LLM connections',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: { content: { 'application/json': { schema: z.array(adminGrantSchema) } }, description: 'Active and revoked shared grants.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer token.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Administrator JWT required.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'A shared grant participant is missing.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Shared connection service unavailable.' },
  },
});

const createRoute_ = createRoute({
  method: 'post',
  path: '/',
  tags: ['Administration'],
  summary: 'Grant a user access to an administrator hosted LLM key',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: adminGrantSchema } }, description: 'Shared grant created.' },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Invalid recipient or provider.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer token.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Administrator JWT required.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Shared connection disappeared before it could be projected.' },
    409: { content: { 'application/json': { schema: errorSchema } }, description: 'Active grant already exists.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Administrator hosted key unavailable.' },
  },
});

const revokeRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Administration'],
  summary: 'Revoke a shared LLM connection',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { params: idParams },
  responses: {
    204: { description: 'Grant revoked or was already revoked.' },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Invalid grant id.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer token.' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Administrator JWT required.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Grant not found.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Shared connection service unavailable.' },
  },
});

export const adminLlmShareRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: 'Invalid shared connection request', code: 'invalid_request' }, 400);
    }
  },
})
  .openapi(listRoute, async (c) => {
    try {
      return c.json((await listAdminSharedGrants()).map(adminGrant), 200);
    } catch (error) {
      const mapped = sharedError(error);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      throw error;
    }
  })
  .openapi(createRoute_, async (c) => {
    try {
      const body = c.req.valid('json');
      const created = await createSharedGrant(c.var.userId, body.recipientUserId, body.provider);
      const view = await getAdminSharedGrant(created.id);
      if (!view) return c.json({ error: 'Shared connection is temporarily unavailable', code: 'shared_connection_unavailable' }, 503);
      return c.json(adminGrant(view), 201);
    } catch (error) {
      const mapped = sharedError(error);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      throw error;
    }
  })
  .openapi(revokeRoute, async (c) => {
    const parsed = idParams.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: 'Invalid shared connection id', code: 'invalid_request' }, 400);
    try {
      await revokeSharedGrant(c.var.userId, parsed.data.id, 'admin_revoked');
      return c.body(null, 204);
    } catch (error) {
      const mapped = sharedError(error);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      throw error;
    }
  });
