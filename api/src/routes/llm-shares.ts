import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireJwtAuth, type AuthVariables } from '../middleware/auth.js';
import {
  consentSharedGrant,
  listRecipientSharedGrants,
  SharedLlmError,
  withdrawSharedConsent,
  type SharedRecipientGrantView,
} from '../services/llm-sharing.js';

type AppEnv = { Variables: AuthVariables };

const errorSchema = z.object({ error: z.string(), code: z.string() });
const idParams = z.object({ id: z.string().uuid() });
const emptyConsentBodySchema = {
  type: 'object' as const,
  additionalProperties: false,
  description: 'No request fields are accepted. Omit the body or send a zero-length body.',
};
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
const recipientGrantSchema = z.object({
  id: z.string().uuid(),
  provider: z.enum(['anthropic', 'openai']),
  status: z.literal('active'),
  createdAt: z.string().datetime(),
  consentedAt: z.string().datetime().nullable(),
  policyVersion: z.literal('shared-llm-v1'),
  disclosure: z.object({
    providerName: z.enum(['Anthropic', 'OpenAI']),
    credentialOwner: z.literal('administrator-managed'),
    contentLeavesThisInstance: z.literal(true),
  }),
  usage: usageSchema,
});
const consentSchema = z.object({
  grantId: z.string().uuid(),
  consentedAt: z.string().datetime(),
  policyVersion: z.literal('shared-llm-v1'),
});

function recipientGrant(view: SharedRecipientGrantView) {
  return {
    id: view.id,
    provider: view.provider,
    status: view.status,
    createdAt: view.createdAt.toISOString(),
    consentedAt: view.consentedAt?.toISOString() ?? null,
    policyVersion: view.policyVersion,
    disclosure: {
      providerName: view.disclosure.providerName,
      credentialOwner: view.disclosure.credentialOwner,
      contentLeavesThisInstance: view.disclosure.contentLeavesThisInstance,
    },
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

function sharedError(error: unknown): { status: 400 | 404 | 503; body: { error: string; code: string } } | null {
  if (!(error instanceof SharedLlmError)) return null;
  if (error.code === 'shared_connection_not_found') {
    return { status: 404, body: { error: 'Shared connection not found', code: error.code } };
  }
  if (error.code === 'shared_provider_unsupported' || error.code === 'shared_recipient_invalid') {
    return {
      status: 400,
      body: {
        error: error.code === 'shared_recipient_invalid'
          ? 'Recipient cannot be the grant owner'
          : 'Unsupported shared provider',
        code: error.code,
      },
    };
  }
  return { status: 503, body: { error: 'Shared connection is temporarily unavailable', code: 'shared_connection_unavailable' } };
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Shared LLM Connections'],
  summary: 'List the caller’s active shared LLM connections',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  responses: {
    200: { content: { 'application/json': { schema: z.object({ grants: z.array(recipientGrantSchema) }) } }, description: 'Active recipient-owned grants.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer token.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Shared connection service unavailable.' },
  },
});

const consentRoute = createRoute({
  method: 'post',
  path: '/{id}/consent',
  tags: ['Shared LLM Connections'],
  summary: 'Accept the shared LLM connection disclosure',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: {
    params: idParams,
    body: {
      required: false,
      content: { 'application/json': { schema: emptyConsentBodySchema } },
    },
  },
  responses: {
    200: { content: { 'application/json': { schema: consentSchema } }, description: 'Consent recorded or returned unchanged.' },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Invalid grant id or non-empty request body.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer token.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Grant is missing, revoked, or belongs to another recipient.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Shared connection service unavailable.' },
  },
});

const withdrawRoute = createRoute({
  method: 'delete',
  path: '/{id}/consent',
  tags: ['Shared LLM Connections'],
  summary: 'Withdraw consent for a shared LLM connection',
  security: [{ bearerJwtAuth: [] }],
  middleware: [requireJwtAuth] as const,
  request: { params: idParams },
  responses: {
    204: { description: 'Consent withdrawn, including when it was already absent.' },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Invalid grant id.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid JWT bearer token.' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Shared grant not found.' },
    503: { content: { 'application/json': { schema: errorSchema } }, description: 'Shared connection service unavailable.' },
  },
});

export const llmShareRoutes = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: 'Invalid shared connection request', code: 'invalid_request' }, 400);
    }
  },
})
  .openapi(listRoute, async (c) => {
    try {
      const grants = await listRecipientSharedGrants(c.var.userId);
      return c.json({ grants: grants.map(recipientGrant) }, 200);
    } catch (error) {
      const mapped = sharedError(error);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      throw error;
    }
  })
  .openapi(consentRoute, async (c) => {
    const parsed = idParams.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: 'Invalid shared connection id', code: 'invalid_request' }, 400);
    if ((await c.req.text()).trim().length > 0) {
      return c.json({ error: 'Consent request body must be empty', code: 'invalid_request' }, 400);
    }
    try {
      const result = await consentSharedGrant(c.var.userId, parsed.data.id);
      return c.json({
        grantId: result.grantId,
        consentedAt: result.consentedAt.toISOString(),
        policyVersion: result.policyVersion,
      }, 200);
    } catch (error) {
      const mapped = sharedError(error);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      throw error;
    }
  })
  .openapi(withdrawRoute, async (c) => {
    const parsed = idParams.safeParse(c.req.param());
    if (!parsed.success) return c.json({ error: 'Invalid shared connection id', code: 'invalid_request' }, 400);
    try {
      await withdrawSharedConsent(c.var.userId, parsed.data.id);
      return c.body(null, 204);
    } catch (error) {
      const mapped = sharedError(error);
      if (mapped) return c.json(mapped.body, mapped.status) as never;
      throw error;
    }
  });
