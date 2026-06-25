/**
 * api/tests/share-boundary.test.ts — Phase 29 SHARE-03 boundary test (T-29-22 regression gate).
 *
 * The /api/share/* namespace is the SINGLE auditable surface that accepts the
 * `share-token` header (D-02 + SHARE-03). Every OTHER route in the OpenAPI
 * document MUST reject a request whose only credential is a `share-token`
 * header — the rejection takes the shape of 401 (no bearer / no cookie ⇒
 * requireAuth fails) or 403 (resource forbidden after auth check), NOT 200.
 *
 * Threat — T-29-22 (Tampering):
 *   A future plan accidentally mounts a mutation route under `/api/share/*`,
 *   OR accidentally teaches `requireAuth` / `requireJwtAuth` to fall through
 *   to `share-token` when the bearer slot is empty. Either regression silently
 *   broadens the share-token credential domain. This test enumerates every
 *   non-`/share/*` route in the OpenAPI doc and asserts the gate fires.
 *
 * Sanity baseline:
 *   - `/api/share/entries` with the same `share-token` header returns 200,
 *     proving the seed token is actually valid (guards against a silently
 *     broken seed where every assertion would pass for the wrong reason).
 *   - The non-share path-spec count is ≥ 5 — guards against an empty
 *     OpenAPI doc or a filter that accidentally matches everything.
 *
 * Lane: DB-gated (integration) — the test inserts a real `share_tokens` row
 * via Plan 01's `generateShareToken` so the boundary assertion uses a token
 * `requireShareToken` actually accepts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { shareTokens, universes } from '../src/db/schema.js';

let handle: TestDbHandle;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
let plaintext: string;

/**
 * OpenAPI path placeholders are substituted with this fake UUID so requests
 * reach the auth middleware. The gate fires BEFORE any DB lookup that would
 * care whether the resource exists, so a constant UUID is sufficient.
 */
const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  handle = await createTestDb();
  const { setTestDb } = await import('../src/db/client.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setTestDb(handle.db as any, handle.pool);
  const indexModule = await import('../src/index.js');
  app = indexModule.createApp();

  // Seed a real, active share token so the boundary test's header is one
  // that `requireShareToken` actually accepts. Without a valid token the
  // assertions cannot distinguish "route rejects share-token specifically"
  // from "route returns 401 for missing auth" — the test must use a token
  // requireShareToken WOULD accept on the /api/share/* baseline.
  const user = await createTestUser(handle, {
    email: 'boundary@test.local',
    password: 'longenoughpw12',
    displayName: 'Boundary Tester',
  });
  const [univ] = await handle.db
    .insert(universes)
    .values({ userId: user.id, name: 'Boundary Test Universe' })
    .returning();
  const { generateShareToken } = await import('../src/services/share-token.js');
  const seed = generateShareToken();
  plaintext = seed.plaintext;
  await handle.db.insert(shareTokens).values({
    userId: user.id,
    universeId: univ!.id,
    label: 'boundary-test',
    hash: seed.hash,
    bodySuffix: seed.bodySuffix,
  });
});

afterAll(async () => {
  await handle.cleanup();
});

async function appRequest(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { ...options.headers },
    body: options.body,
  });
  const res = await app.fetch(req);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  if (res.status !== 204) {
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
  }
  return { status: res.status, body: json };
}

/**
 * Substitute every {placeholder} in an OpenAPI path with FAKE_UUID. The
 * substituted path is prefixed with `/api` to match the app's actual URL
 * surface (the OpenAPI doc reports paths without the `/api` prefix because
 * `servers[0].url = '/api'`).
 */
function buildRequestPath(openapiPath: string): string {
  return '/api' + openapiPath.replace(/\{[^}]+\}/g, FAKE_UUID);
}

/**
 * Discover all non-/share/* path+method specs from the OpenAPI doc. SHARE-03
 * explicitly excludes the /api/share/* namespace — those routes ARE expected
 * to accept share-token. Returns one spec per HTTP method per path.
 */
async function loadNonSharePathSpecs(): Promise<Array<{ path: string; method: string }>> {
  const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
  if (res.status !== 200) {
    throw new Error(`/api/openapi.json returned ${res.status}; expected 200`);
  }
  const doc = (await res.json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const specs: Array<{ path: string; method: string }> = [];
  for (const [openapiPath, methodsObj] of Object.entries(doc.paths)) {
    // SHARE-03: the /share/* read namespace is the single auditable surface
    // that accepts share-token. Filter it out — those routes are expected
    // to behave the OPPOSITE of the assertion in this test.
    if (openapiPath.startsWith('/share/')) continue;
    if (!methodsObj || typeof methodsObj !== 'object') continue;
    for (const method of Object.keys(methodsObj)) {
      // Skip OpenAPI extensions like 'parameters', 'summary' that may appear
      // as siblings of HTTP verbs.
      const verb = method.toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(verb)) continue;
      specs.push({ path: openapiPath, method: verb });
    }
  }
  return specs;
}

describe('SHARE-03: non-share routes reject share-token-only auth (T-29-22)', () => {
  it('enumerates every non-/share/* OpenAPI path and asserts 401/403 with share-token-only header', async () => {
    const specs = await loadNonSharePathSpecs();

    // Sanity baseline 1: doc + filter actually produced a non-trivial set.
    // Guards against the doc being empty or the filter accidentally matching
    // every path (e.g. typo in startsWith).
    expect(
      specs.length,
      `expected at least 5 non-share path+method specs in /api/openapi.json; observed ${specs.length}. ` +
        `Either the OpenAPI doc is empty/broken or the /share/* filter is mismatching.`,
    ).toBeGreaterThanOrEqual(5);

    // Per-spec assertion: each non-share path+method MUST return 401 or 403
    // when called with ONLY a `share-token` header. requireAuth fires the
    // 401 path (no bearer); requireJwtAuth + the per-route guards may surface
    // 403 once the bearer slot is empty but a different middleware rejects.
    // 404 is NOT an acceptable response for this test — a route returning
    // 404 to a missing-bearer request is leaking route existence information
    // when called by a share-token holder (i.e. it's accepting the request
    // far enough to reach a handler that returns 404). The whole point of
    // the boundary is "share-token MUST NOT cross the auth gate at all."
    //
    // 200 — the share-token actually unlocked the route. T-29-22 regression.
    // 5xx — handler crashed; share-token reached the body parser. Also fail.
    for (const spec of specs) {
      const requestPath = buildRequestPath(spec.path);
      const res = await appRequest(spec.method.toUpperCase(), requestPath, {
        headers: {
          'share-token': plaintext,
          // Some routes parse JSON bodies; an empty `{}` body is safe and
          // never blocks the auth gate from firing first (Hono runs route-
          // level middleware before validator middleware).
          'content-type': 'application/json',
        },
        body:
          spec.method === 'post' || spec.method === 'put' || spec.method === 'patch'
            ? '{}'
            : undefined,
      });
      expect(
        [401, 403],
        `T-29-22 boundary violated: ${spec.method.toUpperCase()} ${requestPath} returned ` +
          `status=${res.status} when called with ONLY a share-token header. ` +
          `Non-/share/* routes MUST reject share-token-only auth (401 or 403). ` +
          `If a new route legitimately accepts share-token, mount it under /api/share/*. ` +
          `Body snippet: ${JSON.stringify(res.body)?.slice(0, 200)}`,
      ).toContain(res.status);
    }
  });
});

describe('SHARE-03 baseline sanity (the seed produced a valid token)', () => {
  it('GET /api/share/entries with the same share-token header returns 200', async () => {
    // If THIS request did not return 200 the seed is broken or the share
    // router is unmounted. Without this check, every assertion in the
    // boundary suite could pass for the wrong reason (token rejected
    // everywhere, including the /share/* surface).
    const res = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': plaintext },
    });
    expect(
      res.status,
      `SHARE-03 baseline broken: GET /api/share/entries returned ${res.status} ` +
        `with the seed share-token. Expected 200. ` +
        `Either the seed (universes + share_tokens insert) failed, ` +
        `or shareRoutes is not mounted on /api/share. ` +
        `Body: ${JSON.stringify(res.body)?.slice(0, 200)}`,
    ).toBe(200);
    // Phase 33: share /entries returns a bare array (matches authenticated contract)
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('XREF-07 SC5: v5.2 mutation surface rejects share-token-only callers', () => {
  // These cases are intentionally redundant with the SHARE-03 auto-enumeration
  // (which already covers PATCH /entries/{id} and POST /entries structurally).
  // Their value is a NAMED, documented assertion that a future refactor cannot
  // silently drop — the SHARE-03 loop would catch a regression only if it
  // still enumerates those routes, whereas these named its would catch a
  // regression even if share.ts were somehow mounted at a new prefix.

  it('PATCH /api/universes/{uid}/entries/{id} (alias-update + rename-propagation + linkify) rejects share-token-only', async () => {
    // PATCH /api/universes/:uid/entries/:id is the SINGLE route through which
    // all three v5.2 mutation flows funnel:
    //   - XREF-04 alias-update:         `aliases` field
    //   - XREF-05 rename-propagation:   `title` change → server calls rewriteWikilinks
    //   - XREF-06 linkify:              web sends rewritten `body` via useUpdateEntry
    // A share-token-only caller MUST be rejected (401 or 403) before any body
    // parsing or DB access occurs (requireAuth on the /universes/* router).
    const res = await appRequest(
      'PATCH',
      `/api/universes/${FAKE_UUID}/entries/${FAKE_UUID}`,
      {
        headers: {
          'share-token': plaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'X',
          aliases: ['Y'],
          body: '[[Z]]',
        }),
      },
    );
    expect(
      [401, 403],
      `XREF-07 SC5: PATCH /api/universes/{uid}/entries/{id} MUST reject a share-token-only ` +
        `caller with 401 or 403. This single route covers XREF-04 alias-update (aliases field), ` +
        `XREF-05 rename-propagation (title field → rewriteWikilinks), and XREF-06 linkify ` +
        `(body field sent by UnlinkedMentionsPanel via useUpdateEntry). ` +
        `All three v5.2 mutation flows MUST be unreachable by a share-token-only caller. ` +
        `status=${res.status}, body=${JSON.stringify(res.body)?.slice(0, 200)}`,
    ).toContain(res.status);
  });

  it('POST /api/universes/{uid}/entries (alias-set creation) rejects share-token-only', async () => {
    // POST /api/universes/:uid/entries is the entry-create route which also
    // handles the `aliases` field (XREF-04 alias-set creation path).
    // A share-token-only caller MUST be rejected (401 or 403).
    const res = await appRequest('POST', `/api/universes/${FAKE_UUID}/entries`, {
      headers: {
        'share-token': plaintext,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'New Entry',
        entryType: 'note',
        aliases: ['alias-one'],
      }),
    });
    expect(
      [401, 403],
      `XREF-07 SC5: POST /api/universes/{uid}/entries (alias-set creation, XREF-04) ` +
        `MUST reject a share-token-only caller with 401 or 403. ` +
        `status=${res.status}, body=${JSON.stringify(res.body)?.slice(0, 200)}`,
    ).toContain(res.status);
  });

  it('share.ts declares no mutation route (read-only router invariant)', async () => {
    // Assert that the OpenAPI document declares NO /api/share/* POST/PATCH/DELETE
    // route. This is the structural proof that no v5.2 (or any) mutation was ever
    // mounted under the share prefix — even if a future plan adds a new route
    // and forgets to run the SHARE-03 enumeration, this named assertion catches it.
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, unknown>>;
    };

    // Filter to share-prefixed paths with a mutation HTTP verb
    const shareMutationSpecs: Array<{ path: string; method: string }> = [];
    for (const [openapiPath, methodsObj] of Object.entries(doc.paths)) {
      if (!openapiPath.startsWith('/share/')) continue;
      if (!methodsObj || typeof methodsObj !== 'object') continue;
      for (const method of Object.keys(methodsObj)) {
        const verb = method.toLowerCase();
        if (['post', 'patch', 'put', 'delete'].includes(verb)) {
          shareMutationSpecs.push({ path: openapiPath, method: verb });
        }
      }
    }

    expect(
      shareMutationSpecs,
      `XREF-07 SC5 read-only-router invariant: the OpenAPI document MUST declare ZERO ` +
        `POST/PATCH/PUT/DELETE routes under /share/*. The share router is read-only by ` +
        `construction — all v5.2 mutations (alias-update, rename-propagation, linkify, ` +
        `entry-create) are mounted under /api/universes/* behind requireAuth. ` +
        `A route appearing here means a mutation was accidentally mounted under the share ` +
        `prefix and bypasses the authenticated boundary. ` +
        `Mutation specs found: ${JSON.stringify(shareMutationSpecs)}`,
    ).toHaveLength(0);
  });
});
