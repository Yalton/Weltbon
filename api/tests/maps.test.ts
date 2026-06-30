/**
 * Phase 40 MAPS-04/05 route-level integration tests.
 *
 * Covers:
 *   - MAPS-04: Region CRUD endpoints (POST/PATCH/DELETE .../regions)
 *     - Create region with/without entryId; 201 with row
 *     - Create with cross-universe entryId → 404
 *     - PATCH region updates name/color/entryId; entryId can be set to null (unlink)
 *     - PATCH with cross-universe entryId → 404
 *     - DELETE region → 204; unknown regionId → 404
 *     - Deleting a region does NOT delete the linked entry
 *   - MAPS-05: Pin style PATCH endpoint
 *     - PATCH /pins/:pinId/style sets nullable color + icon → 200
 *   - Regions included in GET detail payload alongside pins
 *   - Auth + IDOR: requireUniverse gates all mutation routes; cross-tenant uid → 404
 *
 * Uses the Phase 39 maps + Phase 38 asset infrastructure to seed map fixtures.
 * Follows the diagrams.test.ts / assets.test.ts integration-test pattern exactly.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bind storage to a temp dir BEFORE importing createApp (mirrors assets.test.ts).
const UPLOADS_TMP = mkdtempSync(join(tmpdir(), 'weltbon-maps-'));
process.env.UPLOADS_DIR = UPLOADS_TMP;

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('map routes (MAPS-04/05 regions + pin style)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
    rmSync(UPLOADS_TMP, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // ─── helpers ───────────────────────────────────────────────────────────────

  async function userWithToken(email: string) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);
    return { user, token, hdrs: authHeader(token) };
  }

  async function req(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: unknown }
  ) {
    const url = `http://localhost${path}`;
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(url, init);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    if (res.status === 204) return null;
    return res.json();
  }

  /** Create a universe and return its id */
  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    const data = await json(res);
    return data.id as string;
  }

  /** Upload a minimal 8x8 PNG asset and return its id.
   *
   * Uses sharp to produce a valid PNG that passes the magic-byte sniff
   * and sharp re-encode pipeline (same approach as assets.test.ts).
   */
  async function uploadAsset(uid: string, hdrs: Record<string, string>) {
    const pngBuf = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 100, g: 150, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const formData = new FormData();
    formData.append('file', new Blob([pngBuf], { type: 'image/png' }), 'map.png');

    const res = await app.request(`http://localhost/api/universes/${uid}/assets`, {
      method: 'POST',
      headers: { ...hdrs },
      body: formData,
    });
    const data = await json(res);
    return data.id as string;
  }

  /** Create a map and return its id */
  async function createMap(uid: string, hdrs: Record<string, string>, assetId: string) {
    const res = await req('POST', `/api/universes/${uid}/maps`, {
      headers: hdrs,
      body: { name: 'Test Map', imageAssetId: assetId },
    });
    const data = await json(res);
    return data.id as string;
  }

  /** Create an entry and return its id */
  async function createEntry(uid: string, hdrs: Record<string, string>, title = 'Test Entry') {
    const res = await req('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { title, entryType: 'location' },
    });
    const data = await json(res);
    return data.id as string;
  }

  /** Seed a full map fixture: user → universe → asset → map → return ids */
  async function seedMap(email = 'a@test.com') {
    const { hdrs } = await userWithToken(email);
    const uid = await createUniverse(hdrs);
    const assetId = await uploadAsset(uid, hdrs);
    const mid = await createMap(uid, hdrs, assetId);
    return { hdrs, uid, mid, assetId };
  }

  // ─── MAPS-04: Region CRUD ──────────────────────────────────────────────────

  it('POST /regions creates a standalone region (no entryId) and returns 201', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Forest', points, color: '#4caf50' },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.id).toBeDefined();
    expect(data.mapId).toBe(mid);
    expect(data.entryId).toBeNull();
    expect(data.name).toBe('Forest');
    expect(data.points).toBe(points);
    expect(data.color).toBe('#4caf50');
  });

  it('POST /regions accepts explicit null entryId and color (UI draw-region payload) and returns 201', async () => {
    // Regression: MapEditor sends { name: '', points, entryId: null, color: null }
    // for a standalone region. createRegionSchema previously used .optional()
    // (no .nullable()), so an explicit null was rejected with 400 — drawing a
    // standalone region failed in the browser even though the handler and DB
    // both accept null. The existing "no entryId" test omits the field
    // (undefined), which never exercised the null path.
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: '', points, entryId: null, color: null },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.entryId).toBeNull();
    expect(data.color).toBeNull();
    expect(data.points).toBe(points);
  });

  it('POST /regions creates a linked region with valid entryId and returns 201', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs);
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.3, y: 0.0 }, { x: 0.3, y: 0.3 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Territory', points, entryId },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.entryId).toBe(entryId);
  });

  it('POST /regions with cross-universe entryId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap('a@test.com');
    // Create a second universe + entry in it
    const uid2 = await createUniverse(hdrs, 'OtherWorld');
    const foreignEntryId = await createEntry(uid2, hdrs);
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { points, entryId: foreignEntryId },
    });

    expect(res.status).toBe(404);
  });

  it('PATCH /regions/:regionId updates name, color, and returns 200', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    // Create region first
    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Old Name', points, color: '#ff0000' },
    });
    const region = await json(createRes);

    // Patch it
    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { name: 'New Name', color: '#00ff00' },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.name).toBe('New Name');
    expect(updated.color).toBe('#00ff00');
  });

  it('PATCH /regions/:regionId can set entryId to null (unlink)', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs);
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Linked', points, entryId },
    });
    const region = await json(createRes);
    expect(region.entryId).toBe(entryId);

    // Unlink by setting entryId to null
    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { entryId: null },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.entryId).toBeNull();
  });

  it('PATCH /regions/:regionId with cross-universe entryId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'MyRegion', points },
    });
    const region = await json(createRes);

    // Cross-universe entry
    const uid2 = await createUniverse(hdrs, 'OtherWorld');
    const foreignEntryId = await createEntry(uid2, hdrs);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { entryId: foreignEntryId },
    });

    expect(patchRes.status).toBe(404);
  });

  it('PATCH /regions/:regionId with unknown regionId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const fakeId = '00000000-0000-4000-8000-000000000001';

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${fakeId}`, {
      headers: hdrs,
      body: { name: 'Whatever' },
    });

    expect(patchRes.status).toBe(404);
  });

  it('DELETE /regions/:regionId returns 204 and does NOT delete the linked entry', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs);
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Doomed Region', points, entryId },
    });
    const region = await json(createRes);

    // Delete the region
    const delRes = await req('DELETE', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
    });

    expect(delRes.status).toBe(204);

    // Verify the entry still exists
    const entryRes = await req('GET', `/api/universes/${uid}/entries/${entryId}`, { headers: hdrs });
    expect(entryRes.status).toBe(200);
  });

  it('DELETE /regions/:regionId with unknown regionId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const fakeId = '00000000-0000-4000-8000-000000000002';

    const delRes = await req('DELETE', `/api/universes/${uid}/maps/${mid}/regions/${fakeId}`, {
      headers: hdrs,
    });

    expect(delRes.status).toBe(404);
  });

  // ─── MAPS-04: Regions in GET detail payload ────────────────────────────────

  it('GET /maps/:mid detail payload includes regions array alongside pins', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    // Create a region
    await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Test Region', points },
    });

    const detailRes = await req('GET', `/api/universes/${uid}/maps/${mid}`, { headers: hdrs });
    expect(detailRes.status).toBe(200);
    const detail = await json(detailRes);

    expect(Array.isArray(detail.pins)).toBe(true);
    expect(Array.isArray(detail.regions)).toBe(true);
    expect(detail.regions).toHaveLength(1);
    expect(detail.regions[0].name).toBe('Test Region');
  });

  // ─── MAPS-05: Legend label persistence ─────────────────────────────────────

  it('PATCH /maps/:mid persists legendLabels alone and round-trips via GET detail', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const labels = JSON.stringify({ '#4caf50:': 'Forests', '#ff5722:star': 'Capitals' });

    // legendLabels must be accepted as the ONLY field (regression: refine
    // previously required name or imageAssetId, so legend renames 400'd).
    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}`, {
      headers: hdrs,
      body: { legendLabels: labels },
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.legendLabels).toBe(labels);

    // GET detail must return the saved labels (regression: mapDetailSchema
    // previously omitted legendLabels, stripping it from the response).
    const detailRes = await req('GET', `/api/universes/${uid}/maps/${mid}`, { headers: hdrs });
    expect(detailRes.status).toBe(200);
    const detail = await json(detailRes);
    expect(detail.legendLabels).toBe(labels);
  });

  it('PATCH /maps/:mid can clear legendLabels with null', async () => {
    const { hdrs, uid, mid } = await seedMap();
    await req('PATCH', `/api/universes/${uid}/maps/${mid}`, {
      headers: hdrs,
      body: { legendLabels: JSON.stringify({ '#000:': 'x' }) },
    });

    const clearRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}`, {
      headers: hdrs,
      body: { legendLabels: null },
    });
    expect(clearRes.status).toBe(200);

    const detailRes = await req('GET', `/api/universes/${uid}/maps/${mid}`, { headers: hdrs });
    const detail = await json(detailRes);
    expect(detail.legendLabels ?? null).toBeNull();
  });

  // ─── MAPS-05: Pin style PATCH ──────────────────────────────────────────────

  it('PATCH /pins/:pinId/style sets color and icon on a pin and returns 200', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs);

    // Add a pin
    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.5, y: 0.5 },
    });
    const pin = await json(pinRes);
    expect(pinRes.status).toBe(201);

    // Update pin style
    const styleRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { color: '#ff5722', icon: 'star' },
    });

    expect(styleRes.status).toBe(200);
    const updated = await json(styleRes);
    expect(updated.color).toBe('#ff5722');
    expect(updated.icon).toBe('star');
  });

  it('PATCH /pins/:pinId/style with unknown pinId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const fakeId = '00000000-0000-4000-8000-000000000003';

    const styleRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${fakeId}/style`, {
      headers: hdrs,
      body: { color: '#ffffff' },
    });

    expect(styleRes.status).toBe(404);
  });

  it('PATCH /pins/:pinId/style can set color and icon to null', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs);

    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.3, y: 0.3 },
    });
    const pin = await json(pinRes);

    // Set style first
    await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { color: '#ff0000', icon: 'crown' },
    });

    // Null out style
    const styleRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { color: null, icon: null },
    });

    expect(styleRes.status).toBe(200);
    const updated = await json(styleRes);
    expect(updated.color).toBeNull();
    expect(updated.icon).toBeNull();
  });

  // ─── Auth / IDOR ────────────────────────────────────────────────────────────

  it('region routes require auth — no token returns 401', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      body: { name: 'Unauthorized', points },
    });

    expect(res.status).toBe(401);
  });

  it('region routes reject cross-tenant uid — returns 403 (Forbidden)', async () => {
    const { hdrs, uid, mid } = await seedMap('owner@test.com');
    // Different user — requireUniverse returns 403 when universe exists but caller doesn't own it
    const { hdrs: otherHdrs } = await userWithToken('attacker@test.com');
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: otherHdrs,
      body: { name: 'IDOR attempt', points },
    });

    // requireUniverse: 404 if universe missing, 403 if caller doesn't own it
    expect(res.status === 403 || res.status === 404).toBe(true);
  });

  it('pin style route requires auth — no token returns 401', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs);
    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.5, y: 0.5 },
    });
    const pin = await json(pinRes);

    const res = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      body: { color: '#ff0000' },
    });

    expect(res.status).toBe(401);
  });

  // ─── Phase 43 TERRAIN-01/02: terrainTypeId on region create/update/read ───

  /** Create a layer + terrain type for the given universe; returns the terrainTypeId */
  async function createTerrainType(
    uid: string,
    hdrs: Record<string, string>,
    layerName = 'Biomes',
    typeName = 'Forest',
    typeColor = '#4caf50',
  ) {
    // Create a layer
    const layerRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: layerName, ordered: false },
    });
    expect(layerRes.status).toBe(201);
    const layer = await json(layerRes);

    // Add a terrain type to the layer
    const typeRes = await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: typeName, color: typeColor },
    });
    expect(typeRes.status).toBe(201);
    const terrainType = await json(typeRes);
    return { layerId: layer.id as string, terrainTypeId: terrainType.id as string };
  }

  it('POST /regions with terrainTypeId returns 201 and round-trips terrainTypeId', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const { terrainTypeId } = await createTerrainType(uid, hdrs);
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: '', points, entryId: null, color: null, terrainTypeId },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.terrainTypeId).toBe(terrainTypeId);
    expect(data.entryId).toBeNull();

    // Also verify GET detail returns terrainTypeId on the region row
    const detailRes = await req('GET', `/api/universes/${uid}/maps/${mid}`, { headers: hdrs });
    expect(detailRes.status).toBe(200);
    const detail = await json(detailRes);
    const created = detail.regions.find((r: { id: string }) => r.id === data.id);
    expect(created?.terrainTypeId).toBe(terrainTypeId);
  });

  it('POST /regions without terrainTypeId returns terrainTypeId null (political region)', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.6 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Forest', points, color: '#4caf50' },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    // terrainTypeId should be null when omitted (political/standalone region)
    expect(data.terrainTypeId ?? null).toBeNull();
  });

  it('PATCH /regions/:regionId with terrainTypeId reclassifies the area', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const { terrainTypeId: typeId1 } = await createTerrainType(uid, hdrs, 'Layer A', 'Grassland', '#90ee90');
    const { terrainTypeId: typeId2 } = await createTerrainType(uid, hdrs, 'Layer B', 'Desert', '#d2b48c');
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.3, y: 0.0 }, { x: 0.3, y: 0.3 }]);

    // Create terrain area with typeId1
    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: '', points, entryId: null, color: null, terrainTypeId: typeId1 },
    });
    expect(createRes.status).toBe(201);
    const region = await json(createRes);
    expect(region.terrainTypeId).toBe(typeId1);

    // Reclassify to typeId2 via PATCH
    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { terrainTypeId: typeId2 },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.terrainTypeId).toBe(typeId2);
  });

  it('PATCH /regions/:regionId omitting terrainTypeId leaves it unchanged', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const { terrainTypeId } = await createTerrainType(uid, hdrs);
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.4 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Terrain', points, entryId: null, color: null, terrainTypeId },
    });
    const region = await json(createRes);
    expect(region.terrainTypeId).toBe(terrainTypeId);

    // PATCH only the name — terrainTypeId should NOT change
    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { name: 'Renamed' },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.terrainTypeId).toBe(terrainTypeId);
    expect(updated.name).toBe('Renamed');
  });

  // ─── WR-04: Cross-universe terrainTypeId IDOR regression tests ────────────

  it('POST /regions with cross-universe terrainTypeId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap('a@test.com');
    // Create a terrain type in a DIFFERENT universe owned by the same user
    const uid2 = await createUniverse(hdrs, 'OtherWorld');
    const { terrainTypeId: foreignTypeId } = await createTerrainType(uid2, hdrs);
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: '', points, entryId: null, color: null, terrainTypeId: foreignTypeId },
    });

    expect(res.status).toBe(404);
  });

  it('PATCH /regions/:regionId with cross-universe terrainTypeId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap('a@test.com');
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    // Create a terrain area in the correct universe
    const { terrainTypeId: ownTypeId } = await createTerrainType(uid, hdrs);
    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: '', points, entryId: null, color: null, terrainTypeId: ownTypeId },
    });
    expect(createRes.status).toBe(201);
    const region = await json(createRes);

    // Attempt to reclassify using a terrain type from a DIFFERENT universe
    const uid2 = await createUniverse(hdrs, 'OtherWorld');
    const { terrainTypeId: foreignTypeId } = await createTerrainType(uid2, hdrs);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { terrainTypeId: foreignTypeId },
    });

    expect(patchRes.status).toBe(404);
  });

  // ─── Phase 51 ROUTE-01/02: Route CRUD + IDOR ──────────────────────────────

  it('POST /routes creates a standalone route (no entryId) and returns 201 with defaults', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'The Road', points, color: '#ff5722' },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.id).toBeDefined();
    expect(data.mapId).toBe(mid);
    expect(data.entryId).toBeNull();
    expect(data.name).toBe('The Road');
    expect(data.points).toBe(points);
    expect(data.color).toBe('#ff5722');
    // Default style fields
    expect(data.lineStyle).toBe('solid');
    expect(data.width).toBe(4);
    expect(data.showArrow).toBe(false);
  });

  it('POST /routes accepts explicit null entryId and color and returns 201', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 1.0, y: 1.0 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: '', points, entryId: null, color: null },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.entryId).toBeNull();
    expect(data.color).toBeNull();
  });

  it('POST /routes creates a linked route with valid entryId and returns 201', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs, 'Journey Route Entry');
    const points = JSON.stringify([{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Hero Journey', points, entryId },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.entryId).toBe(entryId);
  });

  it('POST /routes with cross-universe entryId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap('route-a@test.com');
    const uid2 = await createUniverse(hdrs, 'OtherWorld');
    const foreignEntryId = await createEntry(uid2, hdrs);
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }]);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { points, entryId: foreignEntryId },
    });

    expect(res.status).toBe(404);
  });

  it('PATCH /routes/:routeId updates name and color and returns 200', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.5, y: 0.5 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Old Name', points, color: '#ff0000' },
    });
    const route = await json(createRes);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/routes/${route.id}`, {
      headers: hdrs,
      body: { name: 'New Name', color: '#00ff00' },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.name).toBe('New Name');
    expect(updated.color).toBe('#00ff00');
  });

  it('PATCH /routes/:routeId updates style fields (lineStyle dashed + showArrow true)', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.5, y: 0.5 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Trade Route', points },
    });
    const route = await json(createRes);
    expect(route.lineStyle).toBe('solid');
    expect(route.showArrow).toBe(false);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/routes/${route.id}`, {
      headers: hdrs,
      body: { lineStyle: 'dashed', showArrow: true, width: 6 },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.lineStyle).toBe('dashed');
    expect(updated.showArrow).toBe(true);
    expect(updated.width).toBe(6);
  });

  it('PATCH /routes/:routeId can set entryId to null (unlink)', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs, 'Route Entry');
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 1.0, y: 1.0 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Linked', points, entryId },
    });
    const route = await json(createRes);
    expect(route.entryId).toBe(entryId);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/routes/${route.id}`, {
      headers: hdrs,
      body: { entryId: null },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.entryId).toBeNull();
  });

  it('PATCH /routes/:routeId with cross-universe entryId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.5, y: 0.5 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'MyRoute', points },
    });
    const route = await json(createRes);

    const uid2 = await createUniverse(hdrs, 'OtherWorld');
    const foreignEntryId = await createEntry(uid2, hdrs);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/routes/${route.id}`, {
      headers: hdrs,
      body: { entryId: foreignEntryId },
    });

    expect(patchRes.status).toBe(404);
  });

  it('DELETE /routes/:routeId returns 204 and does NOT delete the linked entry', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs, 'Journey');
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 1.0, y: 1.0 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Doomed Route', points, entryId },
    });
    const route = await json(createRes);

    const delRes = await req('DELETE', `/api/universes/${uid}/maps/${mid}/routes/${route.id}`, {
      headers: hdrs,
    });

    expect(delRes.status).toBe(204);

    // Verify the entry still exists
    const entryRes = await req('GET', `/api/universes/${uid}/entries/${entryId}`, { headers: hdrs });
    expect(entryRes.status).toBe(200);
  });

  it('DELETE /routes/:routeId with unknown routeId returns 404', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const fakeId = '00000000-0000-4000-8000-000000000010';

    const delRes = await req('DELETE', `/api/universes/${uid}/maps/${mid}/routes/${fakeId}`, {
      headers: hdrs,
    });

    expect(delRes.status).toBe(404);
  });

  it('GET /maps/:mid detail payload includes routes array alongside pins and regions', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.5, y: 0.5 }]);

    await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Test Route', points },
    });

    const detailRes = await req('GET', `/api/universes/${uid}/maps/${mid}`, { headers: hdrs });
    expect(detailRes.status).toBe(200);
    const detail = await json(detailRes);

    expect(Array.isArray(detail.pins)).toBe(true);
    expect(Array.isArray(detail.regions)).toBe(true);
    expect(Array.isArray(detail.routes)).toBe(true);
    expect(detail.routes).toHaveLength(1);
    expect(detail.routes[0].name).toBe('Test Route');
    expect(detail.routes[0].lineStyle).toBe('solid');
  });

  // ─── Phase 51 ROUTE-02: IDOR guard (wrong mid → 404) ──────────────────────

  it('PATCH /routes/:routeId via a foreign mid returns 404 (IDOR guard)', async () => {
    const { hdrs, uid, mid } = await seedMap();
    // Create a second map in the same universe
    const assetId = await uploadAsset(uid, hdrs);
    const mid2 = await createMap(uid, hdrs, assetId);
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.5, y: 0.5 }]);

    // Create the route under mid
    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Secret Route', points },
    });
    const route = await json(createRes);

    // Attempt to mutate it through mid2 (the route belongs to mid, not mid2)
    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid2}/routes/${route.id}`, {
      headers: hdrs,
      body: { name: 'IDOR attempt' },
    });

    expect(patchRes.status).toBe(404);
  });

  it('DELETE /routes/:routeId via a foreign mid returns 404 (IDOR guard)', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const assetId = await uploadAsset(uid, hdrs);
    const mid2 = await createMap(uid, hdrs, assetId);
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.5, y: 0.5 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Secret Route', points },
    });
    const route = await json(createRes);

    // Attempt to delete it through mid2
    const delRes = await req('DELETE', `/api/universes/${uid}/maps/${mid2}/routes/${route.id}`, {
      headers: hdrs,
    });

    expect(delRes.status).toBe(404);
  });

  // ─── Phase 52 SECRET-01: secret toggle on pin / region / route ────────────

  it('PATCH /pins/:pinId/style with {secret:true} sets secret on a pin and returns 200', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs);

    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.1, y: 0.2 },
    });
    const pin = await json(pinRes);
    expect(pin.secret).toBe(false);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { secret: true },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.secret).toBe(true);
  });

  it('PATCH /pins/:pinId/style secret-only PATCH passes the at-least-one-field guard', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const entryId = await createEntry(uid, hdrs);

    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.1, y: 0.2 },
    });
    const pin = await json(pinRes);

    // A secret-only body (no color, no icon) must not be rejected by the .refine() guard
    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { secret: false },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.secret).toBe(false);
  });

  it('PATCH /regions/:regionId with {secret:true} sets secret on a region and returns 200', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.4, y: 0.0 }, { x: 0.4, y: 0.4 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Hidden Realm', points, entryId: null, color: null },
    });
    const region = await json(createRes);
    expect(region.secret).toBe(false);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { secret: true },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.secret).toBe(true);
  });

  it('PATCH /routes/:routeId with {secret:true} sets secret on a route and returns 200', async () => {
    const { hdrs, uid, mid } = await seedMap();
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.5, y: 0.5 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/routes`, {
      headers: hdrs,
      body: { name: 'Hidden Road', points },
    });
    const route = await json(createRes);
    expect(route.secret).toBe(false);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/routes/${route.id}`, {
      headers: hdrs,
      body: { secret: true },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.secret).toBe(true);
  });

  // ─── NEST-01: targetMapId schema widening (Task 1 RED) ────────────────────

  it('NEST-01 (T1-schema): POST /pins with targetMapId and no entryId creates a map-only pin (201)', async () => {
    // RED before Task 1: createPinSchema requires entryId → body rejected with 400.
    // GREEN after Task 1 schema: entryId is optional, body accepted.
    // GREEN after Task 2 handler: targetMapId is persisted in the row.
    const { hdrs, uid, mid, assetId } = await seedMap('nest01-t1a@test.com');
    const targetMapId = await createMap(uid, hdrs, assetId);

    const res = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { x: 0.5, y: 0.5, targetMapId },
    });

    expect(res.status).toBe(201);
    const pin = await json(res);
    expect(pin.id).toBeDefined();
    expect(pin.entryId).toBeNull();
    // targetMapId persisted by Task 2 handler:
    expect(pin.targetMapId).toBe(targetMapId);
  });

  it('NEST-01 (T1-schema): PATCH /pins/:pinId/style with only targetMapId passes the refine guard (200)', async () => {
    // RED before Task 1: pinStyleSchema refine requires at least color/icon/secret →
    // a targetMapId-only body returns 400.
    const { hdrs, uid, mid, assetId } = await seedMap('nest01-t1b@test.com');
    const entryId = await createEntry(uid, hdrs);
    const targetMapId = await createMap(uid, hdrs, assetId);

    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.3, y: 0.3 },
    });
    const pin = await json(pinRes);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { targetMapId },
    });

    expect(patchRes.status).toBe(200);
  });

  it('NEST-01 (T1-schema): PATCH /regions/:regionId with only targetMapId passes the refine guard (200)', async () => {
    // RED before Task 1: updateRegionSchema refine requires at least name/color/entryId/
    // terrainTypeId/secret → a targetMapId-only body returns 400.
    const { hdrs, uid, mid, assetId } = await seedMap('nest01-t1c@test.com');
    const targetMapId = await createMap(uid, hdrs, assetId);
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.4, y: 0.0 }, { x: 0.4, y: 0.4 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Forest', points },
    });
    const region = await json(createRes);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { targetMapId },
    });

    expect(patchRes.status).toBe(200);
  });

  // ─── NEST-01: target_map_id universe validation (Task 2 RED) ──────────────
  // These tests are RED after Task 1 (schema accepts targetMapId) but before
  // Task 2 (handler validates universe membership and self-target).

  it('NEST-01 (T2-handler): PATCH /pins/:pinId/style in-universe targetMapId → 200 with targetMapId set', async () => {
    const { hdrs, uid, mid, assetId } = await seedMap('nest01-t2a@test.com');
    const entryId = await createEntry(uid, hdrs);
    const targetMapId = await createMap(uid, hdrs, assetId);

    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.2, y: 0.2 },
    });
    const pin = await json(pinRes);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { targetMapId },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.targetMapId).toBe(targetMapId);

    // Clearing targetMapId via null also works
    const clearRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { targetMapId: null },
    });
    expect(clearRes.status).toBe(200);
    const cleared = await json(clearRes);
    expect(cleared.targetMapId).toBeNull();
  });

  it('NEST-01 (T2-handler): PATCH /pins/:pinId/style cross-universe targetMapId → 404', async () => {
    const { hdrs, uid, mid } = await seedMap('nest01-t2b@test.com');
    const entryId = await createEntry(uid, hdrs);

    // Other universe — different user with their own map
    const { mid: otherMid } = await seedMap('nest01-t2b-other@test.com');

    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.2, y: 0.2 },
    });
    const pin = await json(pinRes);

    const res = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { targetMapId: otherMid },
    });

    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error).toMatch(/target map not found/i);
  });

  it('NEST-01 (T2-handler): PATCH /pins/:pinId/style self-target (targetMapId === mid) → 400', async () => {
    const { hdrs, uid, mid } = await seedMap('nest01-t2c@test.com');
    const entryId = await createEntry(uid, hdrs);

    const pinRes = await req('POST', `/api/universes/${uid}/maps/${mid}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.2, y: 0.2 },
    });
    const pin = await json(pinRes);

    const res = await req('PATCH', `/api/universes/${uid}/maps/${mid}/pins/${pin.id}/style`, {
      headers: hdrs,
      body: { targetMapId: mid },
    });

    // Self-target is rejected — a pin cannot target its own map
    expect(res.status).toBe(400);
  });

  it('NEST-01 (T2-handler): PATCH /regions/:regionId in-universe targetMapId → 200 with targetMapId set', async () => {
    const { hdrs, uid, mid, assetId } = await seedMap('nest01-t2d@test.com');
    const targetMapId = await createMap(uid, hdrs, assetId);
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.4, y: 0.0 }, { x: 0.4, y: 0.4 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Target Region', points, entryId: null },
    });
    const region = await json(createRes);

    const patchRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { targetMapId },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.targetMapId).toBe(targetMapId);

    // Clearing via null
    const clearRes = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { targetMapId: null },
    });
    expect(clearRes.status).toBe(200);
    const cleared = await json(clearRes);
    expect(cleared.targetMapId).toBeNull();
  });

  it('NEST-01 (T2-handler): PATCH /regions/:regionId cross-universe targetMapId → 404', async () => {
    const { hdrs, uid, mid } = await seedMap('nest01-t2e@test.com');
    const { mid: otherMid } = await seedMap('nest01-t2e-other@test.com');
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.4, y: 0.0 }, { x: 0.4, y: 0.4 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Region', points, entryId: null },
    });
    const region = await json(createRes);

    const res = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { targetMapId: otherMid },
    });

    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error).toMatch(/target map not found/i);
  });

  it('NEST-01 (T2-handler): PATCH /regions/:regionId self-target (targetMapId === mid) → 400', async () => {
    const { hdrs, uid, mid } = await seedMap('nest01-t2f@test.com');
    const points = JSON.stringify([{ x: 0.0, y: 0.0 }, { x: 0.4, y: 0.0 }, { x: 0.4, y: 0.4 }]);

    const createRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Self-Link Region', points, entryId: null },
    });
    const region = await json(createRes);

    const res = await req('PATCH', `/api/universes/${uid}/maps/${mid}/regions/${region.id}`, {
      headers: hdrs,
      body: { targetMapId: mid },
    });

    // Self-target is rejected
    expect(res.status).toBe(400);
  });
});
