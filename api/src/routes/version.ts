/**
 * GET /api/version — build identity, deliberately UNAUTHENTICATED.
 *
 * ── WHY THIS ONE ROUTE IS PUBLIC ─────────────────────────────────────────────
 * Every other non-/share/* route in this app requires a bearer, and
 * tests/share-boundary.test.ts (SHARE-03 / T-29-22) enumerates the OpenAPI doc
 * to prove it. This route is the single exception, and it carries a matching
 * entry in that test's allowlist — adding a second one is a visible diff in a
 * security test, which is the point.
 *
 * The reason it is public is the job it exists to do: `curl <host>/api/version`
 * immediately after `docker compose up -d` is how a deploy is confirmed to be
 * running the code that was just built. A credentialed check cannot be run from
 * a deploy script that has no user, and routes/config.ts already covers the
 * authenticated "what is this instance like" case.
 *
 * ── WHAT IT COSTS ────────────────────────────────────────────────────────────
 * Version and commit disclosure. An unauthenticated visitor learns which build
 * is deployed, which narrows a search for known vulnerabilities in this app's
 * dependencies. That is accepted here: this is a self-hostable worldbuilding
 * tool whose source is available to its operators, so the version tells an
 * attacker little they could not learn by fingerprinting the SPA bundle. It
 * would NOT be an acceptable trade for an instance holding third-party data
 * under a different threat model — revisit this comment before assuming it
 * still holds.
 *
 * Nothing else about the instance may join this payload. The response schema is
 * closed (three fields), and tests/version-route.test.ts pins the exact key set
 * so that a careless addition fails rather than quietly leaking config.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { buildInfo } from '../version.js';

const versionSchema = z.object({
  version: z.string().openapi({ example: '0.2.0' }),
  commit: z.string().nullable().openapi({ example: 'a1b2c3d' }),
  builtAt: z.string().nullable().openapi({ example: '2026-08-24T00:00:00.000Z' }),
});

const getVersionRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['version'],
  summary: 'Build identity of the running instance',
  description:
    'UNAUTHENTICATED by design — this is the deploy-verification endpoint, callable from a '
    + 'script with no user. Reports only version, commit and build time; see the module '
    + 'comment for the disclosure trade-off and the SHARE-03 allowlist entry it requires.',
  responses: {
    200: {
      content: { 'application/json': { schema: versionSchema } },
      description: 'Build identity. `commit` and `builtAt` are null in a dev server.',
    },
  },
});

export const versionRoutes = new OpenAPIHono().openapi(getVersionRoute, (c) =>
  c.json(buildInfo(), 200),
);
