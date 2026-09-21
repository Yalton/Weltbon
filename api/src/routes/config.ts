/**
 * frontend branches on.
 *
 * Deliberately the smallest possible surface: today it carries exactly one
 * field, `localMode`. That is what lets `web/`'s single build (desktop AND
 * hosted ship the identical bundle) decide at runtime whether to render the
 * even show the control, let alone accept a request through it (routes/
 * llm-connections.ts is the server-side half of that same decision, gated on
 * the same `env().localMode`).
 *
 * unauthenticated on the theory that the frontend needs it before login. That
 * consumes this route, is post-login settings UI only — no pre-login
 * consumer exists), and it collided with a real, tested invariant:
 * tests/share-boundary.test.ts (SHARE-03 / T-29-22) enumerates every
 * non-/share/* OpenAPI path and asserts a share-token-only request is
 * rejected everywhere outside that namespace. An unauthenticated route
 * trivially violates that — a visitor's share token is not an Authorization
 * bearer, so `requireAuth` rejects it the same way every other authenticated
 * route does, and the boundary test's enumeration covers this route
 * automatically from now on. `requireAuth` (not `requireJwtAuth`): this
 * route exposes no secret and no per-user data, so there is no reason to
 * exclude PAT holders the way the LLM-key routes deliberately do.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import { env } from '../config.js';

type AppEnv = { Variables: AuthVariables };

const configSchema = z.object({ localMode: z.boolean() });
const errorSchema = z.object({ error: z.string() });

const getConfigRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['config'],
  summary: 'Instance-level facts the shared frontend branches on',
  description:
    'Authenticated (requireAuth — JWT or PAT). No secret or per-user data is exposed; ' +
    'authentication is required only to keep this route inside the SHARE-03 / T-29-22 ' +
    'boundary (a share-token-only request must be rejected on every non-/share/* route).',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: { content: { 'application/json': { schema: configSchema } }, description: 'Instance config.' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Missing or invalid bearer token.' },
  },
});

export const configRoutes = new OpenAPIHono<AppEnv>().openapi(getConfigRoute, (c) =>

  c.json({ localMode: env().localMode }, 200),
);
