/**
 * api/tests/share-maps-boundary.test.ts — Phase 40 MAPS-06 / D-13 boundary and
 * privacy tests for the /api/share/maps and /api/share/maps/:mid read surface.
 *
 * Covers two concerns:
 *
 * A. MAPS-06: share map privacy filtering (T-40-05)
 *    - GET /api/share/maps/:mid drops pins linked to private entries (isPublic=false).
 *    - GET /api/share/maps/:mid drops regions linked to private entries; standalone
 *      regions (entryId IS NULL) are kept (D-11: no privacy owner to gate on).
 *    - GET /api/share/maps body is a bare array (Array.isArray === true, not a wrapper).
 *
 * B. MAPS-06 / D-13: share mutation boundary (T-40-04)
 *    - map mutation routes (POST/PATCH/DELETE /api/universes/:uid/maps/*) reject a
 *      share-token-only caller with 401 or 403.
 *    - pin and region mutation routes are similarly rejected.
 *
 * The mutation assertions duplicate coverage from share-boundary.test.ts SHARE-03
 * (which enumerates ALL non-share routes via OpenAPI introspection), but provide
 * explicit named regression anchors for the new map surface so a future plan that
 * accidentally mounts a mutation under /share/* is caught at the closest scope.
 *
 * Lane: DB-gated (integration). Uses createTestDb + cleanDb for isolation.
 * appRequest helper mirrors share-views.test.ts (no body for GET).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  type TestDbHandle,
} from './helpers.js';
import { entries, maps, mapPins, mapRegions, shareTokens, universes } from '../src/db/schema.js';

let handle: TestDbHandle;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

// Per-test state populated in beforeEach.
let universeId: string;
let activeTokenPlaintext: string;

const FAKE_UUID = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  handle = await createTestDb();
  const { setTestDb } = await import('../src/db/client.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setTestDb(handle.db as any, handle.pool);
  const indexModule = await import('../src/index.js');
  app = indexModule.createApp();
});

afterAll(async () => {
  await handle.cleanup();
});

beforeEach(async () => {
  // Each test starts with an empty DB so seed shapes don't leak across tests.
  await cleanDb(handle);

  const user = await createTestUser(handle, {
    email: `share-maps-boundary-${Date.now()}-${Math.random()}@test.local`,
    password: 'longenoughpw12',
    displayName: 'Share Maps Tester',
  });
  universeId = (
    await handle.db
      .insert(universes)
      .values({ userId: user.id, name: 'Share Maps Test Universe' })
      .returning()
  )[0]!.id;

  const { generateShareToken } = await import('../src/services/share-token.js');
  const seed = generateShareToken();
  activeTokenPlaintext = seed.plaintext;
  await handle.db.insert(shareTokens).values({
    userId: user.id,
    universeId,
    label: 'share-maps-boundary-test',
    hash: seed.hash,
    bodySuffix: seed.bodySuffix,
  });
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
    } catch { /* no body */ }
  }
  return { status: res.status, body: json };
}

// ─── Helper: seed a minimal map row directly (no asset upload needed for share route tests) ─────

async function seedMap(name = 'Test Map') {
  const [row] = await handle.db
    .insert(maps)
    .values({ universeId, name, imageAssetId: null })
    .returning();
  return row!.id;
}

async function seedEntry(opts: { isPublic: boolean; title?: string }) {
  const [row] = await handle.db
    .insert(entries)
    .values({
      universeId,
      title: opts.title ?? 'Test Entry',
      entryType: 'location',
      isPublic: opts.isPublic,
    })
    .returning();
  return row!.id;
}

async function seedPin(mapId: string, entryId: string) {
  const [row] = await handle.db
    .insert(mapPins)
    .values({ mapId, entryId, x: 0.5, y: 0.5 })
    .returning();
  return row!.id;
}

async function seedRegion(mapId: string, entryId: string | null, name = 'Region') {
  const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);
  const [row] = await handle.db
    .insert(mapRegions)
    .values({ mapId, entryId, name, points })
    .returning();
  return row!.id;
}

// ─── MAPS-06: share map privacy filtering ─────────────────────────────────────

describe('MAPS-06: share map privacy filtering', () => {
  it('GET /api/share/maps/:mid drops pins linked to private entries (T-40-05)', async () => {
    const mid = await seedMap();
    const publicEntryId = await seedEntry({ isPublic: true, title: 'Public Place' });
    const privateEntryId = await seedEntry({ isPublic: false, title: 'Secret Place' });
    await seedPin(mid, publicEntryId);
    await seedPin(mid, privateEntryId);

    const res = await appRequest('GET', `/api/share/maps/${mid}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body.pins).toBeDefined();
    expect(res.body.pins.length).toBe(1);
    expect(res.body.pins[0].entryId).toBe(publicEntryId);
  });

  it('GET /api/share/maps/:mid drops linked-private-entry regions but keeps standalone (D-11)', async () => {
    const mid = await seedMap();
    const privateEntryId = await seedEntry({ isPublic: false, title: 'Secret Territory' });
    // Linked region to private entry — should be dropped
    await seedRegion(mid, privateEntryId, 'Secret Territory Region');
    // Standalone region (entryId=null) — should be kept (D-11: no privacy owner)
    await seedRegion(mid, null, 'Standalone Territory');

    const res = await appRequest('GET', `/api/share/maps/${mid}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body.regions).toBeDefined();
    expect(res.body.regions.length).toBe(1);
    expect(res.body.regions[0].entryId).toBeNull();
    expect(res.body.regions[0].name).toBe('Standalone Territory');
  });

  it('GET /api/share/maps returns a bare array (Array.isArray === true, not a wrapper)', async () => {
    // Seed one map so the response is non-empty and the shape is exercised.
    await seedMap('Map Alpha');

    const res = await appRequest('GET', '/api/share/maps', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(
      Array.isArray(res.body),
      `Expected bare array but got: ${JSON.stringify(res.body)?.slice(0, 200)}`,
    ).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Map Alpha');
  });

  it('GET /api/share/maps/:mid returns 404 for unknown or cross-universe map', async () => {
    // Use a fake UUID that does not belong to this universe
    const res = await appRequest('GET', `/api/share/maps/${FAKE_UUID}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(404);
  });
});

// ─── MAPS-06 / D-13: share mutation boundary ──────────────────────────────────
//
// The existing share-boundary.test.ts SHARE-03 enumeration already guards the
// full non-share route set via OpenAPI introspection. This describe block adds
// explicit named assertions for the map/pin/region mutation routes — providing
// readable regression anchors close to the Phase 40 code surface.

describe('MAPS-06 / D-13: share mutation boundary (T-40-04)', () => {
  it('POST /api/universes/:uid/maps (create map) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'POST',
      `/api/universes/${FAKE_UUID}/maps`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Attack Map', imageAssetId: FAKE_UUID }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('PATCH /api/universes/:uid/maps/:mid (update map) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'PATCH',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hacked Name' }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('DELETE /api/universes/:uid/maps/:mid rejects share-token-only caller', async () => {
    const res = await appRequest(
      'DELETE',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}`,
      {
        headers: { 'share-token': activeTokenPlaintext },
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/universes/:uid/maps/:mid/pins (create pin) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'POST',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/pins`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ entryId: FAKE_UUID, x: 0.5, y: 0.5 }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('PATCH /api/universes/:uid/maps/:mid/pins/:pinId (move pin) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'PATCH',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/pins/${FAKE_UUID}`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ x: 0.1, y: 0.1 }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('DELETE /api/universes/:uid/maps/:mid/pins/:pinId rejects share-token-only caller', async () => {
    const res = await appRequest(
      'DELETE',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/pins/${FAKE_UUID}`,
      {
        headers: { 'share-token': activeTokenPlaintext },
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/universes/:uid/maps/:mid/regions (create region) rejects share-token-only caller', async () => {
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);
    const res = await appRequest(
      'POST',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/regions`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Attack Region', points }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('PATCH /api/universes/:uid/maps/:mid/regions/:regionId rejects share-token-only caller', async () => {
    const res = await appRequest(
      'PATCH',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/regions/${FAKE_UUID}`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hacked Region' }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('DELETE /api/universes/:uid/maps/:mid/regions/:regionId rejects share-token-only caller', async () => {
    const res = await appRequest(
      'DELETE',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/regions/${FAKE_UUID}`,
      {
        headers: { 'share-token': activeTokenPlaintext },
      },
    );

    expect([401, 403]).toContain(res.status);
  });
});
