/**
 * Phase 41 — SC4 maps export→reimport round-trip integration test.
 *
 * Covers:
 *   - SC4: upload asset → create map using that asset → place pin → create region
 *     → export JSON ZIP → import into clean universe → verify map + pin + asset
 *     reference + entry link all resolve with new UUIDs.
 *   - Backward-compat: existing export/import (version 2.0.0) without maps still
 *     imports successfully (maps defaults to []).
 *
 * NOTE: UPLOADS_DIR must be set BEFORE importing createApp (same as import-export-assets.test.ts).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bind storage to a temp dir BEFORE any import that pulls in the storageBackend singleton.
const UPLOADS_TMP = mkdtempSync(join(tmpdir(), 'weltbon-import-export-maps-'));
process.env.UPLOADS_DIR ??= UPLOADS_TMP;

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import { createApp } from '../src/index.js';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  authHeader,
  type TestDbHandle,
} from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('import-export-maps (SC4)', () => {
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

  async function jsonReq(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: unknown },
  ) {
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(`http://localhost${path}`, init);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  async function createUniverse(hdrs: Record<string, string>, name = 'MapWorld') {
    const res = await jsonReq('POST', '/api/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(
    uid: string,
    hdrs: Record<string, string>,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await jsonReq('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { title: 'Test Entry', entryType: 'concept', body: '', summary: '', ...overrides },
    });
    return json(res);
  }

  /** Upload a tiny PNG via multipart. Returns the asset JSON (id, mimeType, etc.). */
  async function uploadAsset(
    uid: string,
    hdrs: Record<string, string>,
    width = 8,
    height = 8,
  ) {
    const pngBytes = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 100, g: 150, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const fd = new FormData();
    const blob = new Blob([pngBytes], { type: 'image/png' });
    fd.append('file', blob, 'test.png');
    const res = await app.request(`http://localhost/api/universes/${uid}/assets`, {
      method: 'POST',
      headers: { ...hdrs },
      body: fd,
    });
    if (res.status !== 201) {
      throw new Error(`upload failed with status ${res.status}: ${await res.text()}`);
    }
    return json(res);
  }

  /** Create a map with the given imageAssetId. Returns the map object. */
  async function createMap(uid: string, hdrs: Record<string, string>, imageAssetId: string) {
    const res = await jsonReq('POST', `/api/universes/${uid}/maps`, {
      headers: hdrs,
      body: { name: 'Test Map', imageAssetId },
    });
    if (res.status !== 201) {
      throw new Error(`createMap failed with status ${res.status}: ${await res.text()}`);
    }
    return json(res);
  }

  /** Place a pin on a map. Returns the pin object. */
  async function createPin(
    uid: string,
    mapId: string,
    entryId: string,
    hdrs: Record<string, string>,
  ) {
    const res = await jsonReq(
      'POST',
      `/api/universes/${uid}/maps/${mapId}/pins`,
      { headers: hdrs, body: { entryId, x: 0.5, y: 0.5 } },
    );
    if (res.status !== 201) {
      throw new Error(`createPin failed with status ${res.status}: ${await res.text()}`);
    }
    return json(res);
  }

  /** Create a region on a map. Returns the region object. */
  async function createRegion(
    uid: string,
    mapId: string,
    hdrs: Record<string, string>,
    opts: { entryId?: string | null; name?: string; terrainTypeId?: string | null } = {},
  ) {
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);
    const body: Record<string, unknown> = {
      name: opts.name ?? 'Test Region',
      points,
      entryId: opts.entryId ?? null,
    };
    if (opts.terrainTypeId !== undefined) body.terrainTypeId = opts.terrainTypeId;
    const res = await jsonReq(
      'POST',
      `/api/universes/${uid}/maps/${mapId}/regions`,
      { headers: hdrs, body },
    );
    if (res.status !== 201) {
      throw new Error(`createRegion failed with status ${res.status}: ${await res.text()}`);
    }
    return json(res);
  }

  /** Phase 44 GEOSHARE-02: Create a map layer. Returns the layer object. */
  async function createLayer(
    uid: string,
    hdrs: Record<string, string>,
    opts: { name?: string; ordered?: boolean } = {},
  ) {
    const res = await jsonReq(
      'POST',
      `/api/universes/${uid}/map-layers`,
      { headers: hdrs, body: { name: opts.name ?? 'Test Layer', ordered: opts.ordered ?? false } },
    );
    if (res.status !== 201) {
      throw new Error(`createLayer failed with status ${res.status}: ${await res.text()}`);
    }
    return json(res);
  }

  /** Phase 44 GEOSHARE-02: Create a terrain type on a layer. Returns the terrain type object. */
  async function createTerrainType(
    uid: string,
    layerId: string,
    hdrs: Record<string, string>,
    opts: { name?: string; color?: string; label?: string } = {},
  ) {
    const res = await jsonReq(
      'POST',
      `/api/universes/${uid}/map-layers/${layerId}/terrain-types`,
      { headers: hdrs, body: { name: opts.name ?? 'Test Terrain', color: opts.color ?? '#3a7a3a' } },
    );
    if (res.status !== 201) {
      throw new Error(`createTerrainType failed with status ${res.status}: ${await res.text()}`);
    }
    return json(res);
  }

  /**
   * Export the universe as a ZIP (format=json → application/zip, v2.0.0).
   * Returns the zip bytes as a Buffer.
   */
  async function exportAsZip(uid: string, hdrs: Record<string, string>): Promise<Buffer> {
    const res = await app.request(
      `http://localhost/api/universes/${uid}/export?format=json`,
      { headers: hdrs },
    );
    if (res.status !== 200) {
      throw new Error(`export failed with status ${res.status}: ${await res.text()}`);
    }
    expect(res.headers.get('content-type')).toBe('application/zip');
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Import a ZIP file via multipart POST /api/universes/import.
   * Returns the import result JSON.
   */
  async function importZip(zipBytes: Buffer, hdrs: Record<string, string>) {
    const fd = new FormData();
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    fd.append('file', blob, 'universe.zip');
    const res = await app.request('http://localhost/api/universes/import', {
      method: 'POST',
      headers: { ...hdrs },
      body: fd,
    });
    return { status: res.status, body: await json(res) };
  }

  // ─── SC4 Round-trip test ─────────────────────────────────────────────────────

  it('exports ZIP + reimports: map + pin + asset ref + region all resolve with new UUIDs', async () => {
    const { hdrs } = await userWithToken('sc4-maps-rt@test.com');
    const universe = await createUniverse(hdrs, 'MapWorld');

    // 1. Upload a map image asset.
    const mapAsset = await uploadAsset(universe.id, hdrs);

    // 2. Create an entry to link via pin + region.
    const entry = await createEntry(universe.id, hdrs, { title: 'Linked Location' });

    // 3. Create a map using the asset.
    const map = await createMap(universe.id, hdrs, mapAsset.id);

    // 4. Place a pin on the map linked to the entry.
    await createPin(universe.id, map.id, entry.id, hdrs);

    // 5. Create a region on the map (linked to same entry to exercise entryIdMap remap).
    await createRegion(universe.id, map.id, hdrs, { entryId: entry.id, name: 'Test Region' });

    // 6. Export as ZIP.
    const zipBytes = await exportAsZip(universe.id, hdrs);
    expect(zipBytes.length).toBeGreaterThan(0);

    // 7. Import the ZIP into a new universe.
    const { status, body: importResult } = await importZip(zipBytes, hdrs);
    expect(status, `import failed: ${JSON.stringify(importResult)}`).toBe(201);
    expect(importResult.assetCount).toBe(1);
    expect(importResult.entryCount).toBe(1);
    expect(importResult.mapCount).toBe(1);
    expect(importResult.mapPinCount).toBe(1);
    expect(importResult.mapRegionCount).toBe(1);

    const newUniverseId: string = importResult.universeId;

    // 8. Fetch maps in the new universe and assert map exists with remapped asset ref.
    const mapsRes = await jsonReq('GET', `/api/universes/${newUniverseId}/maps`, { headers: hdrs });
    expect(mapsRes.status).toBe(200);
    const newMaps = await json(mapsRes);
    expect(newMaps).toHaveLength(1);
    expect(newMaps[0].name).toBe('Test Map');
    // imageAssetId must be remapped — not the original ID.
    expect(newMaps[0].imageAssetId, 'imageAssetId should be remapped (not null)').toBeTruthy();
    expect(newMaps[0].imageAssetId).not.toBe(mapAsset.id);

    // 9. Fetch map detail; pin and region must reference remapped entry IDs.
    const newMapId = newMaps[0].id;
    const mapDetailRes = await jsonReq(
      'GET',
      `/api/universes/${newUniverseId}/maps/${newMapId}`,
      { headers: hdrs },
    );
    expect(mapDetailRes.status).toBe(200);
    const newMapDetail = await json(mapDetailRes);

    expect(newMapDetail.pins).toHaveLength(1);
    expect(newMapDetail.pins[0].entryId).not.toBe(entry.id); // remapped

    expect(newMapDetail.regions).toHaveLength(1);
    expect(newMapDetail.regions[0].entryId).not.toBe(entry.id); // remapped

    // 10. Asset bytes are retrievable in the new universe via the remapped asset ID.
    const rawRes = await app.request(
      `http://localhost/api/universes/${newUniverseId}/assets/${newMaps[0].imageAssetId}/raw`,
      { headers: hdrs },
    );
    expect(rawRes.status, 'map asset bytes not retrievable after import').toBe(200);
  });

  // ─── Phase 44 GEOSHARE-02: Terrain palette round-trip test ─────────────────

  it('exports ZIP + reimports: terrain layer + type + painted region all round-trip with remapped UUIDs', async () => {
    const { hdrs } = await userWithToken('sc4-terrain-rt@test.com');
    const universe = await createUniverse(hdrs, 'TerrainWorld');

    // 1. Upload a map image asset.
    const mapAsset = await uploadAsset(universe.id, hdrs);

    // 2. Create a map layer (ordered = true for ranked terrain bands).
    const layer = await createLayer(universe.id, hdrs, { name: 'Elevation', ordered: true });

    // 3. Create a terrain type in the layer.
    const terrainType = await createTerrainType(universe.id, layer.id, hdrs, {
      name: 'Highland',
      color: '#7a5c3a',
    });

    // 4. Create a map using the asset.
    const map = await createMap(universe.id, hdrs, mapAsset.id);

    // 5. Create a terrain region tagged with the terrain type (paint the area).
    const terrainRegion = await createRegion(universe.id, map.id, hdrs, {
      name: 'Highland Zone',
      terrainTypeId: terrainType.id,
    });
    expect(terrainRegion.terrainTypeId).toBe(terrainType.id);

    // 6. Export as ZIP.
    const zipBytes = await exportAsZip(universe.id, hdrs);
    expect(zipBytes.length).toBeGreaterThan(0);

    // 7. Import the ZIP into a new universe.
    const { status, body: importResult } = await importZip(zipBytes, hdrs);
    expect(status, `import failed: ${JSON.stringify(importResult)}`).toBe(201);

    // Terrain palette counts must be non-zero (GEOSHARE-02 / SC2).
    expect(importResult.mapLayerCount, 'mapLayerCount must be non-zero').toBeGreaterThan(0);
    expect(importResult.terrainTypeCount, 'terrainTypeCount must be non-zero').toBeGreaterThan(0);
    expect(importResult.mapCount).toBe(1);
    expect(importResult.mapRegionCount).toBe(1);

    const newUniverseId: string = importResult.universeId;

    // 8. Fetch the re-imported map detail; terrain region must have a remapped terrainTypeId.
    const newMapsRes = await jsonReq('GET', `/api/universes/${newUniverseId}/maps`, { headers: hdrs });
    expect(newMapsRes.status).toBe(200);
    const newMaps = await json(newMapsRes);
    expect(newMaps).toHaveLength(1);

    const newMapId = newMaps[0].id;
    const mapDetailRes = await jsonReq(
      'GET',
      `/api/universes/${newUniverseId}/maps/${newMapId}`,
      { headers: hdrs },
    );
    expect(mapDetailRes.status).toBe(200);
    const newMapDetail = await json(mapDetailRes);

    // Terrain region must exist and have a remapped (new) terrainTypeId — NOT the original.
    expect(newMapDetail.regions).toHaveLength(1);
    expect(newMapDetail.regions[0].terrainTypeId, 'terrainTypeId must be remapped (non-null)').toBeTruthy();
    expect(newMapDetail.regions[0].terrainTypeId, 'terrainTypeId must be remapped (not original)').not.toBe(terrainType.id);

    // 9. Verify layers round-tripped in the new universe.
    const layersRes = await jsonReq('GET', `/api/universes/${newUniverseId}/map-layers`, { headers: hdrs });
    expect(layersRes.status).toBe(200);
    const newLayers = await json(layersRes);
    expect(newLayers).toHaveLength(1);
    expect(newLayers[0].name).toBe('Elevation');
    expect(newLayers[0].ordered).toBe(true);
    expect(newLayers[0].terrainTypes).toHaveLength(1);
    expect(newLayers[0].terrainTypes[0].name).toBe('Highland');
    // The new terrain type's ID must differ from the original (remapped).
    expect(newLayers[0].terrainTypes[0].id).not.toBe(terrainType.id);
  });

  // ─── Phase 44 GEOSHARE-02: Orphaned terrain ref null-out test (D-44-06) ────

  it('imports a payload with orphaned terrainTypeId: region degrades to plain, no throw', async () => {
    const { hdrs } = await userWithToken('sc4-terrain-orphan@test.com');

    // Hand-craft a payload whose map_regions[].terrainTypeId is a UUID absent from terrainTypes.
    // The import must succeed with the region's terrainTypeId nulled out (D-44-06 lenient).
    const orphanedTypeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mapId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const payload = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'OrphanTerrainWorld', description: 'Orphaned terrain type ref' },
      entries: [],
      links: [],
      maps: [{ id: mapId, name: 'Orphan Map', imageAssetId: null, legendLabels: null }],
      mapPins: [],
      mapRegions: [
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          mapId,
          entryId: null,
          name: 'Orphaned Region',
          points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]),
          color: null,
          // terrainTypeId references a type NOT in the terrainTypes array → must null out.
          terrainTypeId: orphanedTypeId,
        },
      ],
      // terrainTypes is empty (orphan scenario) — no layers/types in this export.
      mapLayers: [],
      terrainTypes: [],
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: payload,
    });
    // Import must succeed (201), not throw on the orphaned terrain type ref.
    expect(res.status, `orphan import must succeed (201), got: ${res.status}`).toBe(201);
    const result = await json(res);
    expect(result.mapRegionCount).toBe(1);

    // The imported region must have terrainTypeId = null (degraded to plain region).
    const newMapsRes = await jsonReq('GET', `/api/universes/${result.universeId}/maps`, { headers: hdrs });
    expect(newMapsRes.status).toBe(200);
    const newMaps = await json(newMapsRes);
    expect(newMaps).toHaveLength(1);

    const mapDetailRes = await jsonReq(
      'GET',
      `/api/universes/${result.universeId}/maps/${newMaps[0].id}`,
      { headers: hdrs },
    );
    expect(mapDetailRes.status).toBe(200);
    const mapDetail = await json(mapDetailRes);
    expect(mapDetail.regions).toHaveLength(1);
    // Orphaned terrainTypeId must be nulled out, not the original orphanedTypeId.
    expect(mapDetail.regions[0].terrainTypeId, 'orphaned terrain ref must null out').toBeNull();
  });

  // ─── Backward-compat test ───────────────────────────────────────────────────

  it('imports a maps-less export (no maps key) with mapCount 0 — backward compat', async () => {
    const { hdrs } = await userWithToken('sc4-maps-compat@test.com');

    // A version 2.0.0 export without maps/mapPins/mapRegions fields.
    const legacyPayload = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'NoMapsUniverse', description: 'Pre-maps export' },
      entries: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          title: 'Old Entry',
          entryType: 'concept',
          summary: '',
          body: '',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
        },
      ],
      links: [],
      // Deliberately NO maps/mapPins/mapRegions/mapLayers/terrainTypes keys — backward-compat
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: legacyPayload,
    });
    expect(res.status, 'backward-compat import should succeed with 201').toBe(201);
    const result = await json(res);
    expect(result.universeName).toBe('NoMapsUniverse');
    expect(result.entryCount).toBe(1);
    expect(result.mapCount ?? 0).toBe(0);
    expect(result.mapPinCount ?? 0).toBe(0);
    expect(result.mapRegionCount ?? 0).toBe(0);
    // Phase 44 GEOSHARE-02 SC2: pre-v5.1 exports (no terrain keys) must yield zero terrain counts.
    expect(result.mapLayerCount ?? 0, 'pre-v5.1 export must have mapLayerCount=0').toBe(0);
    expect(result.terrainTypeCount ?? 0, 'pre-v5.1 export must have terrainTypeCount=0').toBe(0);

    // No maps should appear in the imported universe.
    const mapsRes = await jsonReq('GET', `/api/universes/${result.universeId}/maps`, {
      headers: hdrs,
    });
    expect(mapsRes.status).toBe(200);
    const maps = await json(mapsRes);
    expect(maps).toHaveLength(0);
  });
});
