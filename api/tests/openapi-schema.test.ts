/**
 * Behavioral tests for the OpenAPI schema endpoint and Scalar docs page.
 *
 * Gap 1 — Plan 10-01 T1+T2 / Plan 10-02 T2 / Plan 10-03 T3:
 *   GET /api/openapi.json returns 200 with a valid OpenAPI 3.x doc; both
 *   security schemes present; all 11 router path groups represented.
 *
 * Gap 2 — Plan 10-01 T2 / T-10-04 spoofing mitigation:
 *   tokens.ts routes (POST /auth/tokens, GET /auth/tokens, DELETE /auth/tokens/{id})
 *   declare security:[{ bearerJwtAuth: [] }] and NOT bearerAuth.
 *
 * Gap 3 — Plan 10-04 T1:
 *   GET /api/docs returns 200 HTML containing id="api-reference",
 *   data-url="/api/openapi.json", and the Scalar CDN script.
 *
 * NO database setup — these endpoints are pure schema/HTML and do not touch DB.
 */

import { describe, it, expect } from 'vitest';
import { app } from '../src/index.js';

describe('OpenAPI schema and Scalar docs (Phase 10 — DB-independent)', () => {
  it('declares the peer ownership refusal that a remote handshake can return', async () => {
    // Mutation caught: a peer 403 is mapped to SyncRemoteOwnershipError at
    // runtime, but omitting 403 here makes generated clients treat that real
    // response as undocumented/unreachable.
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
    expect(res.status).toBe(200);
    const doc = await res.json() as any;
    const response = doc.paths['/sync/remotes/{id}/test']?.post?.responses?.['403'];

    expect(response?.content?.['application/json']?.schema?.properties?.code).toMatchObject({
      type: 'string',
    });
  });

  it('declares instanceId as required on the registered-remote test response', async () => {
    // Mutation caught: leaving the owner-facing identity schema on the old
    // three-field contract makes generated clients discard the self-identity
    // field even though testRemote() returns it at runtime.
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
    expect(res.status).toBe(200);
    const doc = await res.json() as any;
    const schema = doc.paths['/sync/remotes/{id}/test']?.post?.responses?.['200']
      ?.content?.['application/json']?.schema;
    expect(schema?.properties?.remote?.properties?.instanceId).toMatchObject({
      type: 'string',
      format: 'uuid',
    });
    expect(schema?.properties?.remote?.required).toContain('instanceId');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Gap 1: GET /api/openapi.json — valid OpenAPI 3.x doc with both security
  //         schemes and paths from all 11 routers.
  // ──────────────────────────────────────────────────────────────────────────
  it('GET /api/openapi.json returns 200 with a valid OpenAPI 3.x document containing both security schemes and all router path groups', async () => {
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));

    expect(res.status).toBe(200);

    const doc = (await res.json()) as {
      openapi: string;
      components?: {
        securitySchemes?: Record<string, { type: string; scheme: string }>;
      };
      paths: Record<string, unknown>;
    };

    // OpenAPI version must be 3.x
    expect(doc.openapi).toMatch(/^3\./);

    // Both security schemes must be present with type:http scheme:bearer
    expect(doc.components?.securitySchemes?.bearerAuth).toBeTruthy();
    expect(doc.components?.securitySchemes?.bearerAuth?.type).toBe('http');
    expect(doc.components?.securitySchemes?.bearerAuth?.scheme).toBe('bearer');

    expect(doc.components?.securitySchemes?.bearerJwtAuth).toBeTruthy();
    expect(doc.components?.securitySchemes?.bearerJwtAuth?.type).toBe('http');
    expect(doc.components?.securitySchemes?.bearerJwtAuth?.scheme).toBe('bearer');

    // Paths from all 11 routers must appear. servers[0].url = '/api', so paths
    // are stored without the /api prefix (e.g. '/auth/login', '/universes', …).
    // We verify one representative path per router group.
    const pathKeys = Object.keys(doc.paths);

    // auth router (POST /auth/register or /auth/login)
    const hasAuthPath = pathKeys.some((p) => p.startsWith('/auth/') && !p.startsWith('/auth/tokens'));
    expect(hasAuthPath, `expected an /auth/* path (not /auth/tokens) in: ${pathKeys.join(', ')}`).toBe(true);

    // tokens router (/auth/tokens)
    const hasTokensPath = pathKeys.some((p) => p.startsWith('/auth/tokens'));
    expect(hasTokensPath, `expected /auth/tokens path in: ${pathKeys.join(', ')}`).toBe(true);

    // universes router
    const hasUniversesPath = pathKeys.some((p) => p === '/universes' || p.startsWith('/universes'));
    expect(hasUniversesPath, `expected /universes path in: ${pathKeys.join(', ')}`).toBe(true);

    // entries router (/universes/{uid}/entries)
    const hasEntriesPath = pathKeys.some((p) => p.includes('/entries'));
    expect(hasEntriesPath, `expected /universes/{uid}/entries path in: ${pathKeys.join(', ')}`).toBe(true);

    // links router (/universes/{uid}/links)
    const hasLinksPath = pathKeys.some((p) => p.includes('/links'));
    expect(hasLinksPath, `expected /universes/{uid}/links path in: ${pathKeys.join(', ')}`).toBe(true);

    // relations router (/universes/{uid}/relations)
    const hasRelationsPath = pathKeys.some((p) => p.includes('/relations'));
    expect(hasRelationsPath, `expected /universes/{uid}/relations path in: ${pathKeys.join(', ')}`).toBe(true);

    // categories router (/universes/{uid}/categories)
    const hasCategoriesPath = pathKeys.some((p) => p.includes('/categories'));
    expect(hasCategoriesPath, `expected /universes/{uid}/categories path in: ${pathKeys.join(', ')}`).toBe(true);

    // issues router (/universes/{uid}/issues)
    const hasIssuesPath = pathKeys.some((p) => p.includes('/issues'));
    expect(hasIssuesPath, `expected /universes/{uid}/issues path in: ${pathKeys.join(', ')}`).toBe(true);

    // graph-data router (/universes/{uid}/graph-data)
    const hasGraphDataPath = pathKeys.some((p) => p.includes('/graph-data'));
    expect(hasGraphDataPath, `expected /universes/{uid}/graph-data path in: ${pathKeys.join(', ')}`).toBe(true);

    // graph-positions router (/universes/{uid}/graph-positions)
    const hasGraphPositionsPath = pathKeys.some((p) => p.includes('/graph-positions'));
    expect(hasGraphPositionsPath, `expected /universes/{uid}/graph-positions path in: ${pathKeys.join(', ')}`).toBe(true);

    // timeline router (/universes/{uid}/timeline or /universes/{uid}/entries/{eid}/timeline-pin)
    const hasTimelinePath = pathKeys.some((p) => p.includes('/timeline'));
    expect(hasTimelinePath, `expected /timeline or /timeline-pin path in: ${pathKeys.join(', ')}`).toBe(true);

    // import router (/universes/import)
    const hasImportPath = pathKeys.some((p) => p.includes('/import'));
    expect(hasImportPath, `expected /universes/import path in: ${pathKeys.join(', ')}`).toBe(true);

    // export router (/universes/{uid}/export)
    const hasExportPath = pathKeys.some((p) => p.includes('/export'));
    expect(hasExportPath, `expected /universes/{uid}/export path in: ${pathKeys.join(', ')}`).toBe(true);

    // TD-02: explicit assertion that /ingest and /ingest/commit are present.
    // The prefix-scan above would NOT catch a dropped ingest router because
    // other routers share the /universes/{uid}/ prefix. These two assertions
    // fail visibly if api/src/routes/ingest.ts is ever unmounted from index.ts.
    expect(
      doc.paths['/universes/{uid}/ingest'],
      `expected doc.paths['/universes/{uid}/ingest'] to be present; saw keys: ${Object.keys(doc.paths).join(', ')}`,
    ).toBeTruthy();
    expect(
      doc.paths['/universes/{uid}/ingest/commit'],
      `expected doc.paths['/universes/{uid}/ingest/commit'] to be present; saw keys: ${Object.keys(doc.paths).join(', ')}`,
    ).toBeTruthy();

    // v2.1 audit cross-phase: explicit assertion that /auth/invites is present.
    // INV-04 is otherwise only covered by api/tests/invites.test.ts (route-level);
    // a regression that silently dropped inviteRoutes from api/src/index.ts would
    // pass invites.test.ts independently but evade the schema test. This guards.
    const authInvitesKeys = Object.keys(doc.paths).filter((p) => p.startsWith('/auth/'));
    expect(
      doc.paths['/auth/invites'],
      `expected doc.paths['/auth/invites'] to be present; available /auth/* keys: ${authInvitesKeys.join(', ') || '(none)'}`,
    ).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Gap 2: tokens.ts routes declare bearerJwtAuth — NOT bearerAuth.
  //         T-10-04 spoofing mitigation: PAT cannot mint/revoke PATs.
  // ──────────────────────────────────────────────────────────────────────────
  it('POST/GET /auth/tokens and DELETE /auth/tokens/{id} declare bearerJwtAuth (not bearerAuth) in the schema', async () => {
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
    expect(res.status).toBe(200);

    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          post?: { security?: Array<Record<string, unknown>> };
          get?: { security?: Array<Record<string, unknown>> };
          delete?: { security?: Array<Record<string, unknown>> };
        }
      >;
    };

    // Log all paths to aid debugging if needed (removed after iteration)
    const tokenListPath = doc.paths['/auth/tokens'];
    expect(tokenListPath, 'doc.paths["/auth/tokens"] must exist').toBeTruthy();

    const tokenItemPath = doc.paths['/auth/tokens/{id}'];
    expect(tokenItemPath, 'doc.paths["/auth/tokens/{id}"] must exist').toBeTruthy();

    // POST /auth/tokens — must declare bearerJwtAuth
    const postSecurity = tokenListPath?.post?.security;
    expect(postSecurity, 'POST /auth/tokens must have a security block').toBeTruthy();
    expect(postSecurity).toEqual(
      expect.arrayContaining([expect.objectContaining({ bearerJwtAuth: [] })])
    );
    // Must NOT have bearerAuth in its security block
    const postHasBearerAuth = postSecurity?.some((s) => 'bearerAuth' in s);
    expect(postHasBearerAuth, 'POST /auth/tokens must NOT declare bearerAuth').toBe(false);

    // GET /auth/tokens — must declare bearerJwtAuth
    const getSecurity = tokenListPath?.get?.security;
    expect(getSecurity, 'GET /auth/tokens must have a security block').toBeTruthy();
    expect(getSecurity).toEqual(
      expect.arrayContaining([expect.objectContaining({ bearerJwtAuth: [] })])
    );
    const getHasBearerAuth = getSecurity?.some((s) => 'bearerAuth' in s);
    expect(getHasBearerAuth, 'GET /auth/tokens must NOT declare bearerAuth').toBe(false);

    // DELETE /auth/tokens/{id} — must declare bearerJwtAuth
    const deleteSecurity = tokenItemPath?.delete?.security;
    expect(deleteSecurity, 'DELETE /auth/tokens/{id} must have a security block').toBeTruthy();
    expect(deleteSecurity).toEqual(
      expect.arrayContaining([expect.objectContaining({ bearerJwtAuth: [] })])
    );
    const deleteHasBearerAuth = deleteSecurity?.some((s) => 'bearerAuth' in s);
    expect(deleteHasBearerAuth, 'DELETE /auth/tokens/{id} must NOT declare bearerAuth').toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Gap 3: GET /api/docs returns Scalar HTML page with required identifiers.
  // ──────────────────────────────────────────────────────────────────────────
  it('GET /api/docs returns 200 HTML containing id="api-reference", data-url="/api/openapi.json", and the Scalar CDN script', async () => {
    const res = await app.fetch(new Request('http://localhost/api/docs'));

    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType, 'content-type must include text/html').toContain('text/html');

    const body = await res.text();

    expect(body, 'body must contain id="api-reference"').toContain('id="api-reference"');
    expect(body, 'body must reference /api/openapi.json').toContain('/api/openapi.json');
    expect(body, 'body must include Scalar CDN script (@scalar/api-reference)').toContain('@scalar/api-reference');
  });
});
