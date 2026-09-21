
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bind storage to a temp dir BEFORE importing createApp (mirrors maps.test.ts).
const UPLOADS_TMP = mkdtempSync(join(tmpdir(), 'weltbon-map-layers-'));
process.env.UPLOADS_DIR = UPLOADS_TMP;

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { db } from '../src/db/client.js';
import { mapRegions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

describe('map-layers routes', () => {
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

  /** Upload a minimal 8x8 PNG asset and return its id */
  async function uploadAsset(uid: string, hdrs: Record<string, string>) {
    const pngBuf = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 1 } },
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

  /** Seed a universe fixture: user → universe → return ids + headers */
  async function seedUniverse(email = 'a@test.com') {
    const { hdrs } = await userWithToken(email);
    const uid = await createUniverse(hdrs);
    return { hdrs, uid };
  }

  // ─── Layer CRUD ────────────────────────────────────────────────────────────

  it('POST /map-layers creates a layer and returns 201 with correct fields', async () => {
    const { hdrs, uid } = await seedUniverse();

    const res = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Biomes' },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.id).toBeDefined();
    expect(data.universeId).toBe(uid);
    expect(data.name).toBe('Biomes');
    expect(data.ordered).toBe(false);
    expect(data.defaultOpacity).toBe(0.6);
    expect(typeof data.sortOrder).toBe('number');
  });

  it('WR-01/02 regression: manually-created layers & terrain types get incrementing sortOrder so reorder actually swaps', async () => {
    const { hdrs, uid } = await seedUniverse();

    // Two manually-created layers (no preset) must NOT both land on sort_order=0.
    const l1 = await json(
      await req('POST', `/api/universes/${uid}/map-layers`, { headers: hdrs, body: { name: 'First' } }),
    );
    const l2 = await json(
      await req('POST', `/api/universes/${uid}/map-layers`, { headers: hdrs, body: { name: 'Second' } }),
    );
    expect(l1.sortOrder).toBe(0);
    expect(l2.sortOrder).toBe(1);

    // Two manually-created terrain types in an ordered layer get 0,1 too.
    const layer = await json(
      await req('POST', `/api/universes/${uid}/map-layers`, { headers: hdrs, body: { name: 'Elevation', ordered: true } }),
    );
    const t1 = await json(
      await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
        headers: hdrs,
        body: { name: 'Lowlands', color: '#84cc16' },
      }),
    );
    const t2 = await json(
      await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
        headers: hdrs,
        body: { name: 'Peaks', color: '#94a3b8' },
      }),
    );
    expect(t1.sortOrder).toBe(0);
    expect(t2.sortOrder).toBe(1);

    // Reorder swap is now meaningful (0<->1), not a 0<->0 no-op.
    await req('PATCH', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types/${t1.id}`, {
      headers: hdrs,
      body: { sortOrder: 1 },
    });
    await req('PATCH', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types/${t2.id}`, {
      headers: hdrs,
      body: { sortOrder: 0 },
    });

    const list = await json(await req('GET', `/api/universes/${uid}/map-layers`, { headers: hdrs }));
    const elevation = list.find((l: any) => l.id === layer.id);
    expect(elevation.terrainTypes.map((t: any) => t.name)).toEqual(['Peaks', 'Lowlands']);
  });

  it('POST /map-layers with ordered=true returns layer with ordered=true', async () => {
    const { hdrs, uid } = await seedUniverse();

    const res = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Elevation', ordered: true },
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.ordered).toBe(true);
  });

  it('GET /map-layers returns 200 bare array including nested terrainTypes', async () => {
    const { hdrs, uid } = await seedUniverse();

    // Create a layer
    const createRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Test Layer' },
    });
    const layer = await json(createRes);

    // Add a terrain type
    await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: 'Forest', color: '#16a34a' },
    });

    const listRes = await req('GET', `/api/universes/${uid}/map-layers`, { headers: hdrs });
    expect(listRes.status).toBe(200);
    const list = await json(listRes);

    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('Test Layer');
    expect(Array.isArray(list[0].terrainTypes)).toBe(true);
    expect(list[0].terrainTypes.length).toBe(1);
    expect(list[0].terrainTypes[0].name).toBe('Forest');
    expect(list[0].terrainTypes[0].color).toBe('#16a34a');
  });

  it('GET /map-layers returns empty array when no layers exist', async () => {
    const { hdrs, uid } = await seedUniverse();

    const res = await req('GET', `/api/universes/${uid}/map-layers`, { headers: hdrs });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  it('PATCH /map-layers/:layerId renames a layer and returns 200', async () => {
    const { hdrs, uid } = await seedUniverse();

    const createRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Old Name' },
    });
    const layer = await json(createRes);

    const patchRes = await req('PATCH', `/api/universes/${uid}/map-layers/${layer.id}`, {
      headers: hdrs,
      body: { name: 'New Name' },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.name).toBe('New Name');
  });

  it('PATCH /map-layers/:layerId updates defaultOpacity and returns 200', async () => {
    const { hdrs, uid } = await seedUniverse();

    const createRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Test' },
    });
    const layer = await json(createRes);

    const patchRes = await req('PATCH', `/api/universes/${uid}/map-layers/${layer.id}`, {
      headers: hdrs,
      body: { defaultOpacity: 0.3 },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.defaultOpacity).toBe(0.3);
  });

  it('DELETE /map-layers/:layerId returns 204 and cascades terrain_types', async () => {
    const { hdrs, uid } = await seedUniverse();

    const createRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Doomed' },
    });
    const layer = await json(createRes);

    // Add a terrain type to the layer
    await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: 'Forest', color: '#16a34a' },
    });

    // Delete the layer
    const delRes = await req('DELETE', `/api/universes/${uid}/map-layers/${layer.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    // Verify the layer + its terrain types are gone (GET list returns empty)
    const listRes = await req('GET', `/api/universes/${uid}/map-layers`, { headers: hdrs });
    const list = await json(listRes);
    expect(list.length).toBe(0);
  });

  // ─── Terrain-type CRUD ─────────────────────────────────────────────────────

  it('POST /:layerId/terrain-types creates a terrain type and returns 201', async () => {
    const { hdrs, uid } = await seedUniverse();

    const layerRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Biomes' },
    });
    const layer = await json(layerRes);

    const typeRes = await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: 'Desert', color: '#d97706', label: null },
    });

    expect(typeRes.status).toBe(201);
    const ttype = await json(typeRes);
    expect(ttype.id).toBeDefined();
    expect(ttype.layerId).toBe(layer.id);
    expect(ttype.name).toBe('Desert');
    expect(ttype.color).toBe('#d97706');
  });

  it('POST /:layerId/terrain-types rejects invalid hex color with 400', async () => {
    const { hdrs, uid } = await seedUniverse();

    const layerRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Test' },
    });
    const layer = await json(layerRes);

    const typeRes = await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: 'Bad Color', color: 'not-a-color' },
    });

    expect(typeRes.status).toBe(400);
  });

  it('PATCH /:layerId/terrain-types/:typeId renames, recolors, and sets label (200)', async () => {
    const { hdrs, uid } = await seedUniverse();

    const layerRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Elevation' },
    });
    const layer = await json(layerRes);

    const typeRes = await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: 'Lowlands', color: '#84cc16' },
    });
    const ttype = await json(typeRes);

    const patchRes = await req(
      'PATCH',
      `/api/universes/${uid}/map-layers/${layer.id}/terrain-types/${ttype.id}`,
      {
        headers: hdrs,
        body: { name: 'Hills', color: '#eab308', label: '200–600 m' },
      }
    );

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.name).toBe('Hills');
    expect(updated.color).toBe('#eab308');
    expect(updated.label).toBe('200–600 m');
  });

  it('PATCH terrain-type sortOrder swap: two types reordered by updating sortOrder', async () => {
    const { hdrs, uid } = await seedUniverse();

    const layerRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Elevation', ordered: true },
    });
    const layer = await json(layerRes);

    // Create two types with sort_order 0 and 1
    const type1Res = await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: 'Lowlands', color: '#84cc16' },
    });
    const type1 = await json(type1Res);

    await req('PATCH', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types/${type1.id}`, {
      headers: hdrs,
      body: { sortOrder: 0 },
    });

    const type2Res = await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: 'Hills', color: '#eab308' },
    });
    const type2 = await json(type2Res);

    await req('PATCH', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types/${type2.id}`, {
      headers: hdrs,
      body: { sortOrder: 1 },
    });

    // Swap: move type1 to sort_order 1, type2 to sort_order 0
    const swap1 = await req(
      'PATCH',
      `/api/universes/${uid}/map-layers/${layer.id}/terrain-types/${type1.id}`,
      { headers: hdrs, body: { sortOrder: 1 } }
    );
    const swap2 = await req(
      'PATCH',
      `/api/universes/${uid}/map-layers/${layer.id}/terrain-types/${type2.id}`,
      { headers: hdrs, body: { sortOrder: 0 } }
    );

    expect(swap1.status).toBe(200);
    expect(swap2.status).toBe(200);

    // Verify order in GET list
    const listRes = await req('GET', `/api/universes/${uid}/map-layers`, { headers: hdrs });
    const list = await json(listRes);
    expect(list[0].terrainTypes[0].name).toBe('Hills');   // sortOrder: 0
    expect(list[0].terrainTypes[1].name).toBe('Lowlands'); // sortOrder: 1
  });

  // ─── DELETE terrain-type → SET NULL on map_regions.terrain_type_id ─────────

  it('DELETE terrain-type → map_regions.terrain_type_id is NULL (T-42-07 SET NULL proof)', async () => {
    const { hdrs, uid } = await seedUniverse();

    // Create a layer + terrain type
    const layerRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Biomes' },
    });
    const layer = await json(layerRes);

    const typeRes = await req('POST', `/api/universes/${uid}/map-layers/${layer.id}/terrain-types`, {
      headers: hdrs,
      body: { name: 'Forest', color: '#16a34a' },
    });
    const ttype = await json(typeRes);

    // Create a map + region tagged with this terrain type
    const assetId = await uploadAsset(uid, hdrs);
    const mid = await createMap(uid, hdrs, assetId);
    const points = JSON.stringify([
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ]);

    const regionRes = await req('POST', `/api/universes/${uid}/maps/${mid}/regions`, {
      headers: hdrs,
      body: { name: 'Forest Area', points },
    });
    const region = await json(regionRes);

    // Tag the region with the terrain type by updating terrainTypeId directly via DB

    // Use handle.db directly to set the discriminator
    await handle.db
      .update(mapRegions)
      .set({ terrainTypeId: ttype.id })
      .where(eq(mapRegions.id, region.id));

    // Verify the region has the terrain_type_id set
    const [before] = await handle.db
      .select({ terrainTypeId: mapRegions.terrainTypeId })
      .from(mapRegions)
      .where(eq(mapRegions.id, region.id));
    expect(before.terrainTypeId).toBe(ttype.id);

    // Delete the terrain type
    const delRes = await req(
      'DELETE',
      `/api/universes/${uid}/map-layers/${layer.id}/terrain-types/${ttype.id}`,
      { headers: hdrs }
    );
    expect(delRes.status).toBe(204);

    // Assert the region now has terrain_type_id = NULL (SET NULL FK behavior, T-42-07)
    const [after] = await handle.db
      .select({ terrainTypeId: mapRegions.terrainTypeId })
      .from(mapRegions)
      .where(eq(mapRegions.id, region.id));
    expect(after.terrainTypeId).toBeNull();
  });

  // ─── IDOR: cross-universe uid ──────────────────────────────────────────────

  it('POST /map-layers with cross-universe uid returns 404 (IDOR)', async () => {
    const { hdrs: aHdrs } = await userWithToken('a@test.com');
    const { hdrs: bHdrs } = await userWithToken('b@test.com');
    const bUid = await createUniverse(bHdrs);

    // User A tries to create a layer in User B's universe → 404
    const res = await req('POST', `/api/universes/${bUid}/map-layers`, {
      headers: aHdrs,
      body: { name: 'Stolen Layer' },
    });

    expect(res.status === 403 || res.status === 404).toBe(true);
  });

  it('PATCH /map-layers/:layerId with cross-universe uid returns 404/403 (IDOR)', async () => {
    const { hdrs: aHdrs } = await userWithToken('a2@test.com');
    const { hdrs: bHdrs } = await userWithToken('b2@test.com');
    const bUid = await createUniverse(bHdrs);

    // Create a layer in B's universe
    const layerRes = await req('POST', `/api/universes/${bUid}/map-layers`, {
      headers: bHdrs,
      body: { name: 'B Layer' },
    });
    const bLayer = await json(layerRes);

    // User A tries to PATCH it
    const res = await req('PATCH', `/api/universes/${bUid}/map-layers/${bLayer.id}`, {
      headers: aHdrs,
      body: { name: 'Hacked' },
    });

    expect(res.status === 403 || res.status === 404).toBe(true);
  });

  it('DELETE /map-layers/:layerId with cross-universe uid returns 404/403 (IDOR)', async () => {
    const { hdrs: aHdrs } = await userWithToken('a3@test.com');
    const { hdrs: bHdrs } = await userWithToken('b3@test.com');
    const bUid = await createUniverse(bHdrs);

    const layerRes = await req('POST', `/api/universes/${bUid}/map-layers`, {
      headers: bHdrs,
      body: { name: 'B Layer' },
    });
    const bLayer = await json(layerRes);

    const res = await req('DELETE', `/api/universes/${bUid}/map-layers/${bLayer.id}`, {
      headers: aHdrs,
    });

    expect(res.status === 403 || res.status === 404).toBe(true);
  });

  it('POST terrain-type with cross-universe uid returns 404/403 (IDOR)', async () => {
    const { hdrs: aHdrs } = await userWithToken('a4@test.com');
    const { hdrs: bHdrs } = await userWithToken('b4@test.com');
    const bUid = await createUniverse(bHdrs);

    const layerRes = await req('POST', `/api/universes/${bUid}/map-layers`, {
      headers: bHdrs,
      body: { name: 'B Layer' },
    });
    const bLayer = await json(layerRes);

    // User A tries to add a terrain type to B's layer
    const res = await req(
      'POST',
      `/api/universes/${bUid}/map-layers/${bLayer.id}/terrain-types`,
      {
        headers: aHdrs,
        body: { name: 'Forest', color: '#16a34a' },
      }
    );

    expect(res.status === 403 || res.status === 404).toBe(true);
  });

  it('terrain-type route with cross-universe layerId returns 404 (IDOR)', async () => {
    // User A owns uid-A + layerId-A; User B owns uid-B
    // User B tries to POST a terrain type using uid-B but layerId-A → 404
    const { hdrs: aHdrs } = await userWithToken('a5@test.com');
    const { hdrs: bHdrs } = await userWithToken('b5@test.com');
    const aUid = await createUniverse(aHdrs, 'A World');
    const bUid = await createUniverse(bHdrs, 'B World');

    // Create a layer in A's universe
    const aLayerRes = await req('POST', `/api/universes/${aUid}/map-layers`, {
      headers: aHdrs,
      body: { name: 'A Layer' },
    });
    const aLayer = await json(aLayerRes);

    // User B tries to use aLayer.id with their own universe uid
    const res = await req(
      'POST',
      `/api/universes/${bUid}/map-layers/${aLayer.id}/terrain-types`,
      {
        headers: bHdrs,
        body: { name: 'Forest', color: '#16a34a' },
      }
    );

    expect(res.status).toBe(404);
  });

  // ─── Preset routes ─────────────────────────────────────────────────────────

  it('POST /presets/biomes returns 201 with a layer and 7 terrain types', async () => {
    const { hdrs, uid } = await seedUniverse();

    const res = await req('POST', `/api/universes/${uid}/map-layers/presets/biomes`, {
      headers: hdrs,
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.name).toBe('Biomes');
    expect(data.ordered).toBe(false);
    expect(data.defaultOpacity).toBe(0.6);
    expect(Array.isArray(data.terrainTypes)).toBe(true);
    expect(data.terrainTypes.length).toBe(7);

    // Check expected biome names are present
    const names = data.terrainTypes.map((t: { name: string }) => t.name);
    expect(names).toContain('Forest');
    expect(names).toContain('Grassland');
    expect(names).toContain('Desert');
    expect(names).toContain('Tundra');
    expect(names).toContain('Ocean');
    expect(names).toContain('Mountains');
    expect(names).toContain('Wetland');
  });

  it('POST /presets/elevation returns 201 with ordered layer and 5 bands with non-null labels', async () => {
    const { hdrs, uid } = await seedUniverse();

    const res = await req('POST', `/api/universes/${uid}/map-layers/presets/elevation`, {
      headers: hdrs,
    });

    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.name).toBe('Elevation');
    expect(data.ordered).toBe(true);
    expect(data.defaultOpacity).toBe(0.6);
    expect(Array.isArray(data.terrainTypes)).toBe(true);
    expect(data.terrainTypes.length).toBe(5);

    // All bands must have non-null labels (D-42-06)
    for (const band of data.terrainTypes) {
      expect(band.label).not.toBeNull();
      expect(typeof band.label).toBe('string');
      expect(band.label.length).toBeGreaterThan(0);
    }

    // Check expected band names
    const names = data.terrainTypes.map((t: { name: string }) => t.name);
    expect(names).toContain('Lowlands');
    expect(names).toContain('Hills');
    expect(names).toContain('Highlands');
    expect(names).toContain('Peaks');
    expect(names).toContain('Alpine');
  });

  it('preset biomes inserts atomically — layer + 7 types appear in GET list', async () => {
    const { hdrs, uid } = await seedUniverse();

    await req('POST', `/api/universes/${uid}/map-layers/presets/biomes`, { headers: hdrs });

    const listRes = await req('GET', `/api/universes/${uid}/map-layers`, { headers: hdrs });
    const list = await json(listRes);

    expect(list.length).toBe(1);
    expect(list[0].name).toBe('Biomes');
    expect(list[0].terrainTypes.length).toBe(7);
  });



  it('PATCH /map-layers/:layerId with {secret:true} sets secret and returns 200', async () => {
    const { hdrs, uid } = await seedUniverse();

    const createRes = await req('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name: 'Hidden Layer' },
    });
    const layer = await json(createRes);
    expect(layer.secret).toBe(false);

    const patchRes = await req('PATCH', `/api/universes/${uid}/map-layers/${layer.id}`, {
      headers: hdrs,
      body: { secret: true },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.secret).toBe(true);
  });
});
