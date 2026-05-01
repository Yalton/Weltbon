# Contributing to Weltbon

## Adding new authenticated API routes

Any new authenticated route MUST mount via the `requireAuth` middleware (`api/src/middleware/auth.ts`).
PAT compatibility is automatic by virtue of Phase 9's middleware design — `requireAuth` accepts both
JWT and PAT bearers transparently. Route handlers do NOT branch on auth method.

For PAT meta-API endpoints (token issuance/revocation), use `requireJwtAuth` instead — this rejects
PAT bearer tokens (D-13: a stolen PAT cannot mint or revoke other PATs).

### Route declaration pattern (Phase 10)

All new routes MUST use `createRoute()` from `@hono/zod-openapi` so the OpenAPI schema at
`/api/openapi.json` stays in sync with the actual API surface automatically. The pattern is:

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../openapi/app.js';

const myRoute = createRoute({
  method: 'post',
  path: '/my-resource',
  security: [{ bearerAuth: [] }],
  request: { body: { content: { 'application/json': { schema: myInputSchema } } } },
  responses: {
    201: { content: { 'application/json': { schema: myOutputSchema } }, description: 'Created' },
    400: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Bad request' },
    401: { content: { 'application/json': { schema: z.object({ error: z.string() }) } }, description: 'Unauthorized' },
  },
});

export const myRoutes = new OpenAPIHono<AppEnv>().openapi(myRoute, async (c) => {
  // handler
});
```

### Interactive API documentation

The full API reference is served at `/api/docs` (Scalar UI). The source schema is at `/api/openapi.json`.
After adding a new route using `createRoute()`, it will appear in the docs automatically on next server start.
