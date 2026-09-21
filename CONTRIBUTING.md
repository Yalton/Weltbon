# Contributing to Weltbon

Weltbon's public core is licensed under the Mozilla Public License 2.0. By contributing, you agree that your contribution is licensed under the same terms and certify it under the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Add a sign-off to every commit:

```bash
git commit --signoff
```

The sign-off records `Signed-off-by: Name <email>` and certifies that you have the right to submit the work. It is not a copyright assignment.

## Public/private boundary

Changes to the web app, API, desktop app, database schema and migrations, sync protocol, import/export formats, and general self-hosting behavior belong in this repository. Do not submit production credentials, customer data, private infrastructure, billing configuration, monitoring destinations, or incident evidence.

Public packages must install, build, and test without private repositories or secrets. New extension points must use documented configuration or versioned interfaces; public code may not import the private hosted-production overlay.

## Before opening a pull request

Install with the locked dependency graph and run the checks affected by your change:

```bash
pnpm install --frozen-lockfile
pnpm --filter api test
pnpm --filter web exec vitest run
pnpm --filter web build
pnpm --filter weltbon-desktop test
```

API integration tests additionally require PostgreSQL; follow the root README. Keep migrations and public protocol/schema changes backward-compatible or document the required version break and migration.

Security reports do not belong in a pull request or public issue. Follow [SECURITY.md](SECURITY.md).

## Adding new authenticated API routes

Any new authenticated route MUST mount via the `requireAuth` middleware (`api/src/middleware/auth.ts`).
PAT compatibility is automatic: `requireAuth` accepts both
JWT and PAT bearers transparently. Route handlers do NOT branch on auth method.

For PAT meta-API endpoints (token issuance/revocation), use `requireJwtAuth` instead — this rejects
PAT bearer tokens (D-13: a stolen PAT cannot mint or revoke other PATs).

### Route declaration pattern

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
