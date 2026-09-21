
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Bind storage to a temp dir BEFORE any import pulls in the storageBackend singleton.
// schema.js at the next import line transitively loads storageBackend which reads

const UPLOADS_TMP = mkdtempSync(join(tmpdir(), 'weltbon-share-maps-'));
process.env.UPLOADS_DIR = UPLOADS_TMP;

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  type TestDbHandle,
} from './helpers.js';
import { assets, entries, maps, mapLayers, mapPins, mapRegions, mapRoutes, terrainTypes, shareTokens, universes } from '../src/db/schema.js';

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
  rmSync(UPLOADS_TMP, { recursive: true, force: true });
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

async function seedRegion(
  mapId: string,
  entryId: string | null,
  name = 'Region',
  terrainTypeId: string | null = null,
) {
  const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);
  const [row] = await handle.db
    .insert(mapRegions)
    .values({ mapId, entryId, name, points, terrainTypeId })
    .returning();
  return row!.id;
}

// D-44-04 / D-44-05 helpers — mirror seedMap/seedRegion for terrain palette seeding
async function seedLayer(name = 'Test Layer') {
  const [row] = await handle.db
    .insert(mapLayers)
    .values({ universeId, name, ordered: false, defaultOpacity: 0.6, sortOrder: 0 })
    .returning();
  return row!.id;
}

async function seedTerrainType(layerId: string, name = 'Test Type', color = '#ff0000') {
  const [row] = await handle.db
    .insert(terrainTypes)
    .values({ layerId, name, color, sortOrder: 0 })
    .returning();
  return row!.id;
}

async function seedMapWithImage(targetUniverseId: string): Promise<string> {
  const { storageBackend } = await import('../src/services/storage/local.js');
  const pngBytes = await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 80, g: 120, b: 200, alpha: 1 } },
  }).png().toBuffer();

  const assetId = crypto.randomUUID();
  await storageBackend.put(assetId, pngBytes);
  await storageBackend.put(`${assetId}_thumb`, pngBytes);

  await handle.db.insert(assets).values({
    id: assetId,
    universeId: targetUniverseId,
    filename: 'map-bg.png',
    mimeType: 'image/png',
    extension: 'png',
    sizeBytes: pngBytes.length,
    thumbSizeBytes: pngBytes.length,
  });

  await handle.db.insert(maps).values({
    universeId: targetUniverseId,
    name: 'Test Map With Image',
    imageAssetId: assetId,
  });

  return assetId;
}

// ─── MAPS-06 regression: serve real map background image via share seam ────────
//

// correctly authorizes serving a map-backing asset and correctly denies cross-universe
// assets. Without the Task-1 fix, both tests would fail (200 → 404, 404 still 404).

describe('MAPS-06: share serves map background image', () => {
  it('GET /api/share/assets/:mapImageId/raw returns 200 for a map image in the token universe', async () => {
    const assetId = await seedMapWithImage(universeId);

    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${assetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': activeTokenPlaintext },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('GET /api/share/assets/:mapImageId/raw returns 404 for a map image in a different universe (cross-universe gate)', async () => {
    // Create a second user + universe + map image. The active share token only covers `universeId`.
    const otherUser = await createTestUser(handle, {
      email: `share-maps-cross-${Date.now()}@test.local`,
      password: 'longenoughpw12',
      displayName: 'Other Universe Owner',
    });
    const [otherUniverse] = await handle.db
      .insert(universes)
      .values({ userId: otherUser.id, name: 'Other Universe' })
      .returning();
    const otherUniverseId = otherUniverse!.id;
    const otherAssetId = await seedMapWithImage(otherUniverseId);

    // Use the active token (scoped to `universeId`) to try to fetch the other universe's map image.
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${otherAssetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': activeTokenPlaintext },
      }),
    );

    // Must be 404 — cross-universe asset, no existence leak (T-41.1-01 / T-41.1-03).
    expect(res.status).toBe(404);
  });
});

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

// ─── D-44-05 / T-44-05: share mutation boundary — map-layers / terrain-types ──
//
// Proves that all 8 mutation routes on the new terrain-layer tables are sealed
// against a share-token-only caller. Mirrors the D-13 boundary block above.
// Routes mounted at /api/universes/:uid/map-layers (api/src/index.ts L142).

describe('D-44-05 / T-44-05: share mutation boundary — map-layers/terrain-types', () => {
  it('POST /api/universes/:uid/map-layers (create layer) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'POST',
      `/api/universes/${FAKE_UUID}/map-layers`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Attack Layer' }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('PATCH /api/universes/:uid/map-layers/:layerId (update layer) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'PATCH',
      `/api/universes/${FAKE_UUID}/map-layers/${FAKE_UUID}`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hacked Layer' }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('DELETE /api/universes/:uid/map-layers/:layerId (delete layer) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'DELETE',
      `/api/universes/${FAKE_UUID}/map-layers/${FAKE_UUID}`,
      {
        headers: { 'share-token': activeTokenPlaintext },
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/universes/:uid/map-layers/presets/biomes rejects share-token-only caller', async () => {
    const res = await appRequest(
      'POST',
      `/api/universes/${FAKE_UUID}/map-layers/presets/biomes`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/universes/:uid/map-layers/presets/elevation rejects share-token-only caller', async () => {
    const res = await appRequest(
      'POST',
      `/api/universes/${FAKE_UUID}/map-layers/presets/elevation`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('POST /api/universes/:uid/map-layers/:layerId/terrain-types (create terrain type) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'POST',
      `/api/universes/${FAKE_UUID}/map-layers/${FAKE_UUID}/terrain-types`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Attack Type', color: '#ff0000' }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('PATCH /api/universes/:uid/map-layers/:layerId/terrain-types/:typeId (update terrain type) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'PATCH',
      `/api/universes/${FAKE_UUID}/map-layers/${FAKE_UUID}/terrain-types/${FAKE_UUID}`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hacked Type' }),
      },
    );

    expect([401, 403]).toContain(res.status);
  });

  it('DELETE /api/universes/:uid/map-layers/:layerId/terrain-types/:typeId (delete terrain type) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'DELETE',
      `/api/universes/${FAKE_UUID}/map-layers/${FAKE_UUID}/terrain-types/${FAKE_UUID}`,
      {
        headers: { 'share-token': activeTokenPlaintext },
      },
    );

    expect([401, 403]).toContain(res.status);
  });
});

// ─── D-44-03 / D-44-04: terrain-area privacy filter + bare-array contract ─────
//
// Proves that:
//   - A region with terrainTypeId set lands in res.body.terrainAreas (not regions).
//   - GET /api/share/map-layers returns a bare array (D-44-04 bare-array contract).

describe('D-44-03 / D-44-04: terrain area discrimination + map-layers bare array', () => {
  it('GET /api/share/maps/:mid puts terrain-tagged region in terrainAreas, not regions (D-44-03)', async () => {
    const mid = await seedMap();
    const layerId = await seedLayer('Biomes');
    const typeId = await seedTerrainType(layerId, 'Forest', '#228b22');

    // Terrain-tagged region (terrainTypeId set) — must land in terrainAreas
    await seedRegion(mid, null, 'Forest Area', typeId);
    // Standalone political region (terrainTypeId null) — must stay in regions
    await seedRegion(mid, null, 'Political Territory', null);

    const res = await appRequest('GET', `/api/share/maps/${mid}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);

    // terrainAreas: one entry with terrainTypeId set
    expect(res.body.terrainAreas).toBeDefined();
    expect(res.body.terrainAreas.length).toBe(1);
    expect(res.body.terrainAreas[0].terrainTypeId).toBe(typeId);
    expect(res.body.terrainAreas[0].name).toBe('Forest Area');
    expect(res.body.terrainAreas[0].terrainTypeColor).toBe('#228b22');
    expect(res.body.terrainAreas[0].layerId).toBe(layerId);

    // regions: only the political/standalone region (no terrainTypeId)
    expect(res.body.regions).toBeDefined();
    expect(res.body.regions.length).toBe(1);
    expect(res.body.regions[0].name).toBe('Political Territory');
    // Confirm the terrain-tagged region did NOT leak into regions
    const terrainInRegions = res.body.regions.some(
      (r: { terrainTypeId: string | null }) => r.terrainTypeId != null,
    );
    expect(terrainInRegions).toBe(false);
  });

  it('GET /api/share/map-layers returns a bare array (D-44-04 bare-array contract)', async () => {
    // Seed one layer so the response is non-empty and Array.isArray is meaningful
    await seedLayer('Test Layer Alpha');

    const res = await appRequest('GET', '/api/share/map-layers', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(
      Array.isArray(res.body),
      `Expected bare array but got: ${JSON.stringify(res.body)?.slice(0, 200)}`,
    ).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Test Layer Alpha');
    // Each layer carries a nested terrainTypes array (bare-array-of-layers-with-nested-types)
    expect(Array.isArray(res.body[0].terrainTypes)).toBe(true);
  });

  it('CR-01: a region carrying BOTH terrainTypeId and a private entryId never reaches share callers', async () => {
    // The API now rejects both-set writes (entryId XOR terrainTypeId), but a row
    // can predate the gate or arrive via raw import. The terrain-areas branch of
    // getPublicMap has no entries.isPublic join, so without its isNull(entryId)
    // guard this row would ship the private entry's UUID to any share visitor.
    const mid = await seedMap();
    const layerId = await seedLayer('Biomes');
    const typeId = await seedTerrainType(layerId, 'Forest', '#228b22');
    const privateEntryId = await seedEntry({ isPublic: false, title: 'Secret Place' });

    // Hand-crafted both-set row, inserted directly (bypasses the write-time gate)
    await seedRegion(mid, privateEntryId, 'Leaky Area', typeId);
    // Control: a clean terrain area that must still render
    await seedRegion(mid, null, 'Clean Area', typeId);

    const res = await appRequest('GET', `/api/share/maps/${mid}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    // The both-set row is dropped from terrainAreas (isNull(entryId) guard) …
    expect(res.body.terrainAreas.length).toBe(1);
    expect(res.body.terrainAreas[0].name).toBe('Clean Area');
    // … and it must not fall through to regions either (it has terrainTypeId set)
    expect(res.body.regions.length).toBe(0);
    // The private entry UUID appears nowhere in the whole payload
    expect(JSON.stringify(res.body)).not.toContain(privateEntryId);
  });
});

async function seedRoute(
  mapId: string,
  opts: { entryId?: string | null; name?: string; secret?: boolean } = {},
) {
  const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }]);
  const [row] = await handle.db
    .insert(mapRoutes)
    .values({
      mapId,
      entryId: opts.entryId ?? null,
      name: opts.name ?? 'Test Route',
      points,
      secret: opts.secret ?? false,
    })
    .returning();
  return row!.id;
}

// ─── T-51-03: share mutation boundary — map_routes ────────────────────────────
//
// Proves that no map_routes mutation is reachable through the /share/:token seam.
// Route mutations are mounted only under the authenticated /universes path
// (api/src/routes/maps.ts /{mid}/routes). A share-token-only caller MUST be
// rejected with 401 or 403 before reaching any handler body.
//
// Mirrors the D-13 boundary block for pins/regions above and D-44-05 for layers.
// Routes mounted at /api/universes/:uid/maps/:mid/routes.

describe('T-51-03: share mutation boundary — map_routes', () => {
  it('POST /api/universes/:uid/maps/:mid/routes (create route) rejects share-token-only caller', async () => {
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }]);
    const res = await appRequest(
      'POST',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/routes`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Attack Route', points }),
      },
    );

    expect(
      [401, 403],
      `T-51-03: POST /maps/:mid/routes must reject share-token-only caller with 401 or 403. ` +
        `Got ${res.status}. If 404: route not mounted (check maps.ts route CRUD). ` +
        `If 200/201: share seam unexpectedly accepted the create — route mutation is exposed.`,
    ).toContain(res.status);
  });

  it('PATCH /api/universes/:uid/maps/:mid/routes/:routeId (update route) rejects share-token-only caller', async () => {
    const res = await appRequest(
      'PATCH',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/routes/${FAKE_UUID}`,
      {
        headers: {
          'share-token': activeTokenPlaintext,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hacked Route' }),
      },
    );

    expect(
      [401, 403],
      `T-51-03: PATCH /maps/:mid/routes/:routeId must reject share-token-only caller. Got ${res.status}.`,
    ).toContain(res.status);
  });

  it('DELETE /api/universes/:uid/maps/:mid/routes/:routeId rejects share-token-only caller', async () => {
    const res = await appRequest(
      'DELETE',
      `/api/universes/${FAKE_UUID}/maps/${FAKE_UUID}/routes/${FAKE_UUID}`,
      {
        headers: { 'share-token': activeTokenPlaintext },
      },
    );

    expect(
      [401, 403],
      `T-51-03: DELETE /maps/:mid/routes/:routeId must reject share-token-only caller. Got ${res.status}.`,
    ).toContain(res.status);
  });
});

// ─── T-52-03/T-52-04/T-52-05: secret item filtering + field-absence ───────────
//
// Boundary tests proving:
//   1. Secret pins (secret=true, public entry) are absent from share GET /maps/:mid.
//   2. Secret political regions (secret=true) are absent from share GET /maps/:mid.
//   3. Secret standalone routes (secret=true) are absent from share GET /maps/:mid.
//   4. Secret terrain-area (region.secret=true) absent; AND non-secret terrain-area
//      under a SECRET layer absent (D-03 OR-cascade). Non-secret area under non-secret
//      layer present (proves correct sibling survives).
//   5. Secret layer absent from GET /api/share/map-layers; non-secret layer present.
//   6. Field-absence: every returned share object must not carry a `secret` key
//      (WR-01 / T-52-05 — @hono/zod-openapi does NOT validate response bodies).
//
// Secret values are seeded directly via DB insert (toggle endpoint lands in 52-03).
// Uses the same share-token header + activeTokenPlaintext flow as all blocks above.

describe('T-52-03/T-52-04/T-52-05: secret item filtering + field-absence', () => {
  it('GET /api/share/maps/:mid drops secret pin, keeps sibling non-secret pin (T-52-03)', async () => {
    const mid = await seedMap();
    const entryId = await seedEntry({ isPublic: true, title: 'Public Entry' });
    // Non-secret pin — must appear in response
    await handle.db.insert(mapPins).values({ mapId: mid, entryId, x: 0.3, y: 0.3, secret: false }).returning();
    // Secret pin — must be absent
    await handle.db.insert(mapPins).values({ mapId: mid, entryId, x: 0.7, y: 0.7, secret: true }).returning();

    const res = await appRequest('GET', `/api/share/maps/${mid}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body.pins.length).toBe(1);
    expect(res.body.pins[0].x).toBeCloseTo(0.3);
    // Field-absence: secret key must not appear on any pin object (T-52-05)
    expect(res.body.pins[0]).not.toHaveProperty('secret');
  });

  it('GET /api/share/maps/:mid drops secret political region, keeps sibling non-secret region (T-52-03)', async () => {
    const mid = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);
    // Non-secret standalone region — must appear
    await handle.db.insert(mapRegions).values({ mapId: mid, entryId: null, name: 'Visible Region', points, secret: false }).returning();
    // Secret standalone region — must be absent
    await handle.db.insert(mapRegions).values({ mapId: mid, entryId: null, name: 'Secret Region', points, secret: true }).returning();

    const res = await appRequest('GET', `/api/share/maps/${mid}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body.regions.length).toBe(1);
    expect(res.body.regions[0].name).toBe('Visible Region');
    // Field-absence: secret key must not appear on any region object (T-52-05)
    expect(res.body.regions[0]).not.toHaveProperty('secret');
  });

  it('GET /api/share/maps/:mid drops secret route, keeps sibling non-secret route (T-52-03)', async () => {
    const mid = await seedMap();
    // Non-secret standalone route — must appear
    await seedRoute(mid, { name: 'Visible Route', secret: false });
    // Secret standalone route — must be absent
    await seedRoute(mid, { name: 'Secret Route', secret: true });

    const res = await appRequest('GET', `/api/share/maps/${mid}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body.routes.length).toBe(1);
    expect(res.body.routes[0].name).toBe('Visible Route');
    // Field-absence: secret key must not appear on any route object (T-52-05)
    expect(res.body.routes[0]).not.toHaveProperty('secret');
  });

  it('GET /api/share/maps/:mid: D-03 OR-cascade — secret terrain area absent; area under secret layer absent; area under non-secret layer present (T-52-04)', async () => {
    const mid = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    // Visible layer + type — non-secret terrain area under non-secret layer → PRESENT
    const visibleLayerId = await seedLayer('Visible Layer');
    const visibleTypeId = await seedTerrainType(visibleLayerId, 'Grassland', '#99cc44');
    await handle.db.insert(mapRegions).values({
      mapId: mid, entryId: null, name: 'Visible Area', points,
      terrainTypeId: visibleTypeId, secret: false,
    });

    // Secret layer + type — non-secret terrain area under SECRET layer → ABSENT (D-03 cascade)
    const [secretLayerRow] = await handle.db
      .insert(mapLayers)
      .values({ universeId, name: 'Secret Layer', ordered: false, defaultOpacity: 0.6, sortOrder: 1, secret: true })
      .returning();
    const secretLayerId = secretLayerRow!.id;
    const secretLayerTypeId = await seedTerrainType(secretLayerId, 'Hidden Terrain', '#333333');
    await handle.db.insert(mapRegions).values({
      mapId: mid, entryId: null, name: 'Area Under Secret Layer', points,
      terrainTypeId: secretLayerTypeId, secret: false,
    });

    // Non-secret layer + type — region.secret=true → ABSENT (item-level filter)
    const anotherLayerId = await seedLayer('Another Layer');
    const anotherTypeId = await seedTerrainType(anotherLayerId, 'Desert', '#cc9900');
    await handle.db.insert(mapRegions).values({
      mapId: mid, entryId: null, name: 'Secret Area', points,
      terrainTypeId: anotherTypeId, secret: true,
    });

    const res = await appRequest('GET', `/api/share/maps/${mid}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    // Only the visible-layer non-secret area survives
    expect(res.body.terrainAreas.length).toBe(1);
    expect(res.body.terrainAreas[0].name).toBe('Visible Area');
    // Field-absence: secret key must not appear on any terrainArea object (T-52-05)
    expect(res.body.terrainAreas[0]).not.toHaveProperty('secret');
  });

  it('GET /api/share/map-layers drops secret layer, keeps sibling non-secret layer; no secret field on layer objects (T-52-05)', async () => {
    // Non-secret layer — must appear
    await seedLayer('Public Layer');
    // Secret layer — must be absent
    await handle.db.insert(mapLayers).values({
      universeId, name: 'Secret Layer', ordered: false, defaultOpacity: 0.6, sortOrder: 1, secret: true,
    });

    const res = await appRequest('GET', '/api/share/map-layers', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Public Layer');
    // Field-absence: secret key must not appear on any layer object (T-52-05)
    expect(res.body[0]).not.toHaveProperty('secret');
  });
});
