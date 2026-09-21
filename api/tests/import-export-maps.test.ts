
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
import { eq } from 'drizzle-orm';
import { mapLayers, mapPins, mapRegions, mapRoutes } from '../src/db/schema.js';

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



  async function createRoute(
    uid: string,
    mapId: string,
    hdrs: Record<string, string>,
    opts: {
      entryId?: string | null;
      name?: string;
      lineStyle?: 'solid' | 'dashed';
      width?: number;
      showArrow?: boolean;
    } = {},
  ) {
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.1 }]);
    const res = await jsonReq(
      'POST',
      `/api/universes/${uid}/maps/${mapId}/routes`,
      {
        headers: hdrs,
        body: {
          name: opts.name ?? 'Test Route',
          points,
          entryId: opts.entryId !== undefined ? opts.entryId : null,
          lineStyle: opts.lineStyle ?? 'solid',
          width: opts.width ?? 4,
          showArrow: opts.showArrow ?? false,
        },
      },
    );
    if (res.status !== 201) {
      throw new Error(`createRoute failed with status ${res.status}: ${await res.text()}`);
    }
    return json(res);
  }



  it('exports ZIP + reimports: routes round-trip with style fields and remapped entryId (ROUTE-03)', async () => {
    const { hdrs } = await userWithToken('sc4-routes-rt@test.com');
    const universe = await createUniverse(hdrs, 'RouteWorld');

    // 1. Upload a map image asset.
    const mapAsset = await uploadAsset(universe.id, hdrs);

    // 2. Create an entry to link via an entry-linked route.
    const entry = await createEntry(universe.id, hdrs, { title: 'Journey Entry' });

    // 3. Create a map using the asset.
    const map = await createMap(universe.id, hdrs, mapAsset.id);

    // 4. Create an entry-linked route (dashed, width 7, showArrow true).
    const linkedRoute = await createRoute(universe.id, map.id, hdrs, {
      name: "King's Road",
      entryId: entry.id,
      lineStyle: 'dashed',
      width: 7,
      showArrow: true,
    });
    expect(linkedRoute.entryId).toBe(entry.id);

    // 5. Create a standalone route (no entry link, default style).
    const standaloneRoute = await createRoute(universe.id, map.id, hdrs, {
      name: 'Merchant Trail',
      entryId: null,
      lineStyle: 'solid',
      width: 4,
      showArrow: false,
    });
    expect(standaloneRoute.entryId).toBeNull();

    // 6. Export as ZIP.
    const zipBytes = await exportAsZip(universe.id, hdrs);
    expect(zipBytes.length).toBeGreaterThan(0);

    // 7. Import into a new universe.
    const { status, body: importResult } = await importZip(zipBytes, hdrs);
    expect(status, `import failed: ${JSON.stringify(importResult)}`).toBe(201);
    expect(importResult.mapRouteCount, 'mapRouteCount must be 2').toBe(2);

    const newUniverseId: string = importResult.universeId;

    // 8. Fetch the re-imported map detail; routes must have style fields intact.
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

    expect(newMapDetail.routes).toHaveLength(2);

    // Find the linked route by name and assert style fields + remapped entryId.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newLinkedRoute = newMapDetail.routes.find((r: any) => r.name === "King's Road");
    expect(newLinkedRoute, 'linked route must be found by name').toBeDefined();
    expect(newLinkedRoute.lineStyle, 'lineStyle must be dashed').toBe('dashed');
    expect(newLinkedRoute.width, 'width must be 7').toBe(7);
    expect(newLinkedRoute.showArrow, 'showArrow must be true').toBe(true);
    // entryId must be remapped — not the original id, and non-null.
    expect(newLinkedRoute.entryId, 'entryId must be remapped (non-null)').toBeTruthy();
    expect(newLinkedRoute.entryId, 'entryId must not be the original').not.toBe(entry.id);

    // Find the standalone route and assert null entryId + default style fields.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newStandaloneRoute = newMapDetail.routes.find((r: any) => r.name === 'Merchant Trail');
    expect(newStandaloneRoute, 'standalone route must be found by name').toBeDefined();
    expect(newStandaloneRoute.entryId, 'standalone route entryId must be null').toBeNull();
    expect(newStandaloneRoute.lineStyle, 'standalone lineStyle must be solid').toBe('solid');
    expect(newStandaloneRoute.width, 'standalone width must be 4').toBe(4);
    expect(newStandaloneRoute.showArrow, 'standalone showArrow must be false').toBe(false);
  });



  it('imports a payload without mapRoutes field succeeds — backward-compat pre-v5.3', async () => {
    const { hdrs } = await userWithToken('sc4-routes-compat@test.com');

    const mapId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    // Hand-craft a v5.1 export that has no mapRoutes key.
    const preV53Payload = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'PreRoutesUniverse', description: 'Pre-v5.3 export without routes' },
      entries: [],
      links: [],
      maps: [{ id: mapId, name: 'Old Map', imageAssetId: null, legendLabels: null }],
      mapPins: [],
      mapRegions: [],
      mapLayers: [],
      terrainTypes: [],
      // Deliberately NO mapRoutes key — pre-v5.3 backward-compat (T-51-09 mitigation).
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: preV53Payload,
    });
    expect(res.status, 'pre-v5.3 import (no mapRoutes) must succeed with 201').toBe(201);
    const result = await json(res);
    // mapRouteCount must be 0 (defaulted to [] by import schema).
    expect(result.mapRouteCount ?? 0, 'missing mapRoutes field must yield 0 routes').toBe(0);

    // No routes should appear in the imported map.
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
    const newMapDetail = await json(mapDetailRes);
    // routes field must be empty (zero routes in pre-v5.3 import).
    expect(newMapDetail.routes ?? [], 'no routes in pre-v5.3 import').toHaveLength(0);
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

    expect(result.mapLayerCount ?? 0, 'pre-v5.1 export must have mapLayerCount=0').toBe(0);
    expect(result.terrainTypeCount ?? 0, 'pre-v5.1 export must have terrainTypeCount=0').toBe(0);

    expect(result.mapRouteCount ?? 0, 'pre-maps export must have mapRouteCount=0').toBe(0);

    // No maps should appear in the imported universe.
    const mapsRes = await jsonReq('GET', `/api/universes/${result.universeId}/maps`, {
      headers: hdrs,
    });
    expect(mapsRes.status).toBe(200);
    const maps = await json(mapsRes);
    expect(maps).toHaveLength(0);
  });



  /**
   * SC-NEST-RT: A pin targeting another map in the export remaps its targetMapId
   * to the newly-inserted map UUID after import.
   * A region targeting the same map also remaps correctly.
   */
  it('NEST-01: targetMapId on pin + region round-trips with remapped map UUID', async () => {
    const { hdrs } = await userWithToken('sc4-nest-rt@test.com');

    // Hand-craft a payload: mapA has a pin targeting mapB; a region on mapA also targets mapB.
    const mapAId = 'a1111111-1111-4111-8111-111111111111';
    const mapBId = 'b2222222-2222-4222-8222-222222222222';
    const entryId = 'c3333333-3333-4333-8333-333333333333';

    const payload = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'NestRoundTripWorld', description: 'nested map link round-trip' },
      entries: [
        {
          id: entryId,
          title: 'Linked Entry',
          entryType: 'location',
          summary: '',
          body: '',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
        },
      ],
      links: [],
      maps: [
        { id: mapAId, name: 'Map A', imageAssetId: null, legendLabels: null },
        { id: mapBId, name: 'Map B', imageAssetId: null, legendLabels: null },
      ],
      // Pin on Map A that targets Map B via targetMapId.
      mapPins: [
        {
          mapId: mapAId,
          entryId,
          x: 0.5,
          y: 0.5,
          color: null,
          icon: null,
          secret: false,
          targetMapId: mapBId,   // <-- the field under test
        },
      ],
      // Region on Map A that also targets Map B.
      mapRegions: [
        {
          mapId: mapAId,
          entryId: null,
          name: 'Nested Region',
          points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]),
          color: null,
          terrainTypeId: null,
          secret: false,
          targetMapId: mapBId,   // <-- the field under test
        },
      ],
      mapRoutes: [],
      mapLayers: [],
      terrainTypes: [],
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: payload,
    });
    expect(res.status, `import must succeed (201), got: ${res.status}`).toBe(201);
    const result = await json(res);
    expect(result.mapCount).toBe(2);
    expect(result.mapPinCount).toBe(1);
    expect(result.mapRegionCount).toBe(1);

    // Find Map A and Map B in the imported universe.
    const newMapsRes = await jsonReq('GET', `/api/universes/${result.universeId}/maps`, { headers: hdrs });
    expect(newMapsRes.status).toBe(200);
    const newMaps = await json(newMapsRes);
    expect(newMaps).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newMapA = newMaps.find((m: any) => m.name === 'Map A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newMapB = newMaps.find((m: any) => m.name === 'Map B');
    expect(newMapA, 'Map A must be found after import').toBeDefined();
    expect(newMapB, 'Map B must be found after import').toBeDefined();

    // Fetch Map A detail; pin's targetMapId must = newMapB.id (remapped, not original mapBId).
    const mapADetailRes = await jsonReq(
      'GET',
      `/api/universes/${result.universeId}/maps/${newMapA.id}`,
      { headers: hdrs },
    );
    expect(mapADetailRes.status).toBe(200);
    const mapADetail = await json(mapADetailRes);

    expect(mapADetail.pins).toHaveLength(1);
    expect(mapADetail.pins[0].targetMapId, 'pin targetMapId must be remapped to newMapB').toBe(newMapB.id);
    expect(mapADetail.pins[0].targetMapId, 'pin targetMapId must not be original mapBId').not.toBe(mapBId);

    expect(mapADetail.regions).toHaveLength(1);
    expect(mapADetail.regions[0].targetMapId, 'region targetMapId must be remapped to newMapB').toBe(newMapB.id);
    expect(mapADetail.regions[0].targetMapId, 'region targetMapId must not be original mapBId').not.toBe(mapBId);
  });

  /**
   * SC-NEST-ORPHAN: A pin/region whose targetMapId is absent from the import
   * must import successfully with targetMapId = null — no throw (T-53-10).
   */
  it('NEST-01: orphaned targetMapId nulls out — no throw (lenient discipline)', async () => {
    const { hdrs } = await userWithToken('sc4-nest-orphan@test.com');

    const mapId = 'd6666666-6666-4666-8666-666666666666';
    const entryId = 'e7777777-7777-4777-8777-777777777777';
    // A UUID for a map that is NOT present in the export.
    const absentMapId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    const payload = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'NestOrphanWorld', description: 'orphaned targetMapId must null out' },
      entries: [
        {
          id: entryId,
          title: 'Entry',
          entryType: 'location',
          summary: '',
          body: '',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
        },
      ],
      links: [],
      maps: [
        { id: mapId, name: 'Only Map', imageAssetId: null, legendLabels: null },
      ],
      mapPins: [
        {
          mapId,
          entryId,
          x: 0.3,
          y: 0.3,
          color: null,
          icon: null,
          secret: false,
          targetMapId: absentMapId,  // <-- orphaned: absentMapId not in maps array
        },
      ],
      mapRegions: [
        {
          mapId,
          entryId: null,
          name: 'Orphan Region',
          points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]),
          color: null,
          terrainTypeId: null,
          secret: false,
          targetMapId: absentMapId,  // <-- orphaned
        },
      ],
      mapRoutes: [],
      mapLayers: [],
      terrainTypes: [],
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: payload,
    });
    // Must succeed — orphan does NOT throw (T-53-10).
    expect(res.status, `orphaned targetMapId import must succeed (201), got: ${res.status}`).toBe(201);
    const result = await json(res);
    expect(result.mapPinCount).toBe(1);
    expect(result.mapRegionCount).toBe(1);

    // Fetch the imported map; pin and region must have targetMapId = null.
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

    expect(mapDetail.pins).toHaveLength(1);
    expect(mapDetail.pins[0].targetMapId, 'orphaned pin targetMapId must null out').toBeNull();

    expect(mapDetail.regions).toHaveLength(1);
    expect(mapDetail.regions[0].targetMapId, 'orphaned region targetMapId must null out').toBeNull();
  });

  /**
   * SC-NEST-MAPONLY: A map-only pin (null entryId, targetMapId set) imports
   * without throwing (D-01a: map-only pins allowed, mirrors region nullable-entryId).
   */
  it('NEST-01: map-only pin (null entryId, targetMapId set) imports cleanly', async () => {
    const { hdrs } = await userWithToken('sc4-nest-maponly@test.com');

    const mapAId = 'aa111111-1111-4111-8111-111111111111';
    const mapBId = 'bb222222-2222-4222-8222-222222222222';

    const payload = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'NestMapOnlyWorld', description: 'map-only pin import test' },
      entries: [],
      links: [],
      maps: [
        { id: mapAId, name: 'Source Map', imageAssetId: null, legendLabels: null },
        { id: mapBId, name: 'Target Map', imageAssetId: null, legendLabels: null },
      ],
      // Map-only pin: entryId is null, targetMapId is set.
      mapPins: [
        {
          mapId: mapAId,
          entryId: null,         // <-- map-only: no entry link
          x: 0.5,
          y: 0.5,
          color: null,
          icon: null,
          secret: false,
          targetMapId: mapBId,   // <-- nested-map link
        },
      ],
      mapRegions: [],
      mapRoutes: [],
      mapLayers: [],
      terrainTypes: [],
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: payload,
    });
    // Map-only pin must NOT cause a throw.
    expect(res.status, `map-only pin import must succeed (201), got: ${res.status}`).toBe(201);
    const result = await json(res);
    expect(result.mapCount).toBe(2);
    expect(result.mapPinCount, 'map-only pin must be counted').toBe(1);

    // Verify the pin imported with null entryId + remapped targetMapId.
    const newMapsRes = await jsonReq('GET', `/api/universes/${result.universeId}/maps`, { headers: hdrs });
    expect(newMapsRes.status).toBe(200);
    const newMaps = await json(newMapsRes);
    expect(newMaps).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newSourceMap = newMaps.find((m: any) => m.name === 'Source Map');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newTargetMap = newMaps.find((m: any) => m.name === 'Target Map');

    const mapDetailRes = await jsonReq(
      'GET',
      `/api/universes/${result.universeId}/maps/${newSourceMap.id}`,
      { headers: hdrs },
    );
    expect(mapDetailRes.status).toBe(200);
    const mapDetail = await json(mapDetailRes);

    expect(mapDetail.pins).toHaveLength(1);
    expect(mapDetail.pins[0].entryId, 'map-only pin entryId must be null').toBeNull();
    expect(mapDetail.pins[0].targetMapId, 'map-only pin targetMapId must be remapped').toBe(newTargetMap.id);
  });

  /**
   * SC-NEST-COMPAT: A pre-v5.3 export payload without targetMapId fields
   * imports cleanly (backward-compat; the field defaults to null via Zod .default(null)).
   */
  it('NEST-01: pre-v5.3 export (no targetMapId field) imports cleanly — backward-compat', async () => {
    const { hdrs } = await userWithToken('sc4-nest-compat@test.com');

    const mapId = 'cc333333-3333-4333-8333-333333333333';
    const entryId = 'dd444444-4444-4444-8444-444444444444';

    // Pre-v5.3 payload: pins and regions have NO targetMapId field at all.
    const preV53Payload = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'PreNestWorld', description: 'pre-v5.3 export without targetMapId' },
      entries: [
        {
          id: entryId,
          title: 'Old Location',
          entryType: 'location',
          summary: '',
          body: '',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
        },
      ],
      links: [],
      maps: [
        { id: mapId, name: 'Legacy Map', imageAssetId: null, legendLabels: null },
      ],
      mapPins: [
        {
          mapId,
          entryId,
          x: 0.4,
          y: 0.6,
          color: null,
          icon: null,
          secret: false,
          // Deliberately NO targetMapId field (pre-v5.3).
        },
      ],
      mapRegions: [
        {
          mapId,
          entryId,
          name: 'Legacy Region',
          points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]),
          color: null,
          terrainTypeId: null,
          secret: false,
          // Deliberately NO targetMapId field (pre-v5.3).
        },
      ],
      mapRoutes: [],
      mapLayers: [],
      terrainTypes: [],
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: preV53Payload,
    });
    // Pre-v5.3 export must import cleanly (no crash on missing targetMapId).
    expect(res.status, `pre-v5.3 import (no targetMapId) must succeed with 201, got: ${res.status}`).toBe(201);
    const result = await json(res);
    expect(result.mapPinCount).toBe(1);
    expect(result.mapRegionCount).toBe(1);

    // Both pin and region should have targetMapId = null.
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

    expect(mapDetail.pins).toHaveLength(1);
    expect(mapDetail.pins[0].targetMapId, 'pre-v5.3 pin must have targetMapId=null').toBeNull();

    expect(mapDetail.regions).toHaveLength(1);
    expect(mapDetail.regions[0].targetMapId, 'pre-v5.3 region must have targetMapId=null').toBeNull();
  });

  // ─── SC3 omnibus: composition round-trip ─────────────────────────────────────
  //
  // Proves that routes + secret items + layer-level secrecy + map-to-map
  // targetMapId links all compose through export→import TOGETHER into a clean
  // universe with all data/styles/flags/ID-remaps intact.
  //
  // Composition interactions exercised:
  //   • secret × route     — a secret route in the same universe as a non-secret route
  //   • secret × targetMapId — a secret pin that ALSO carries a targetMapId
  //   • layer-secrecy × map-to-map region — a region under a secret layer that also targets another map
  //
  // Seed strategy (54-PATTERNS §"Gap in the helper set" pattern #1):
  //   Seed via the HTTP helpers, then set secret/targetMapId on the specific rows
  //   via direct handle.db.update(...) — mirrors how share-maps-boundary.test.ts
  //   seeds secret flags (direct DB insert/update) — THEN export + import.
  //   This path exercises export/payload.ts (DB gather) AND export/json.ts
  //   (serialization) AND import-json.ts (atomic ID-remap insert).

  it('SC3 omnibus: routes + secret items + layer-secrecy + map-to-map links round-trip together into a clean universe', async () => {
    const { hdrs } = await userWithToken('sc3-omnibus@test.com');
    const universe = await createUniverse(hdrs, 'OmnibusWorld');
    const uid = universe.id;

    // 1. Upload map image assets for Map A (source) and Map B (target for nested links).
    const mapAssetA = await uploadAsset(uid, hdrs);
    const mapAssetB = await uploadAsset(uid, hdrs);

    // 2. Create two entries: entryA for the linked route + non-secret pin; entryB for the secret pin.
    const entryA = await createEntry(uid, hdrs, { title: 'Entry Alpha' });
    const entryB = await createEntry(uid, hdrs, { title: 'Entry Beta' });

    // 3. Create Map A (source) and Map B (target) with distinct names for post-import identification.
    const mapARes = await jsonReq('POST', `/api/universes/${uid}/maps`, {
      headers: hdrs,
      body: { name: 'Source Map A', imageAssetId: mapAssetA.id },
    });
    if (mapARes.status !== 201) throw new Error(`createMapA failed: ${await mapARes.text()}`);
    const mapA = await json(mapARes);

    const mapBRes = await jsonReq('POST', `/api/universes/${uid}/maps`, {
      headers: hdrs,
      body: { name: 'Target Map B', imageAssetId: mapAssetB.id },
    });
    if (mapBRes.status !== 201) throw new Error(`createMapB failed: ${await mapBRes.text()}`);
    const mapB = await json(mapBRes);

    // 4. Visible terrain layer + type for the terrainTypeId remap assertion.
    const layer = await createLayer(uid, hdrs, { name: 'Terrain Layer', ordered: false });
    const terrainType = await createTerrainType(uid, layer.id, hdrs, {
      name: 'Grassland',
      color: '#66aa44',
    });

    // 5. Secret layer (for layer-secrecy × map-to-map region interaction).
    //    HTTP create endpoint does not expose `secret`; set via direct DB update.
    const secretLayer = await createLayer(uid, hdrs, { name: 'Secret Layer', ordered: false });
    await handle.db
      .update(mapLayers)
      .set({ secret: true })
      .where(eq(mapLayers.id, secretLayer.id));

    // 6. Terrain type under the secret layer.
    const secretLayerTerrainType = await createTerrainType(uid, secretLayer.id, hdrs, {
      name: 'Hidden Terrain',
      color: '#333333',
    });

    // 7. Non-secret pin on Map A linked to entryA (control — present in both export and import).
    await createPin(uid, mapA.id, entryA.id, hdrs);

    // 8. Secret pin linked to entryB + targetMapId (secret × targetMapId interaction).
    //    Seed via HTTP, then set secret=true + targetMapId via direct DB update.
    const secretPin = await createPin(uid, mapA.id, entryB.id, hdrs);
    await handle.db
      .update(mapPins)
      .set({ secret: true, targetMapId: mapB.id })
      .where(eq(mapPins.id, secretPin.id));

    // 9. Terrain area on Map A under the visible terrain type (for terrainTypeId remap assertion).
    await createRegion(uid, mapA.id, hdrs, {
      name: 'Grass Field',
      terrainTypeId: terrainType.id,
    });

    // 10. Region under the secret layer + targetMapId (layer-secrecy × map-to-map interaction).
    //     Seed via HTTP, then set targetMapId via direct DB update.
    const secretLayerRegion = await createRegion(uid, mapA.id, hdrs, {
      name: 'Hidden Territory',
      terrainTypeId: secretLayerTerrainType.id,
    });
    await handle.db
      .update(mapRegions)
      .set({ targetMapId: mapB.id })
      .where(eq(mapRegions.id, secretLayerRegion.id));

    // 11. Entry-linked route with non-default style (dashed/7/showArrow=true) — style intactness.
    await createRoute(uid, mapA.id, hdrs, {
      name: "King's Road",
      entryId: entryA.id,
      lineStyle: 'dashed',
      width: 7,
      showArrow: true,
    });

    // 12. Secret standalone route with non-default style (secret × route interaction).
    //     Seed via HTTP, then set secret=true via direct DB update.
    const secretRoute = await createRoute(uid, mapA.id, hdrs, {
      name: 'Shadow Path',
      entryId: null,
      lineStyle: 'dashed',
      width: 3,
      showArrow: true,
    });
    await handle.db
      .update(mapRoutes)
      .set({ secret: true })
      .where(eq(mapRoutes.id, secretRoute.id));

    // 13. Export as ZIP — exercises export/payload.ts (DB gather) + export/json.ts (serialization).
    const zipBytes = await exportAsZip(uid, hdrs);
    expect(zipBytes.length).toBeGreaterThan(0);

    // 14. Import into a clean new universe — exercises import-json.ts (ID remap + atomic insert).
    const { status, body: importResult } = await importZip(zipBytes, hdrs);
    expect(status, `import failed: ${JSON.stringify(importResult)}`).toBe(201);

    // 15. Count assertions — exact counts: secret items PRESENT in OWNER import (portability).
    //     A missing count means the item was incorrectly filtered or dropped by the import path.
    //     Exact bounds (not floor) catch idempotency bugs that would duplicate items on re-import.
    expect(importResult.assetCount, 'assetCount must be 2 (two map images)').toBe(2);
    expect(importResult.entryCount, 'entryCount must be 2').toBe(2);
    expect(importResult.mapCount, 'mapCount must be 2 (Map A + Map B)').toBe(2);
    expect(importResult.mapPinCount, 'mapPinCount must be 2 (non-secret pin + secret pin)').toBe(2);
    expect(importResult.mapRegionCount, 'mapRegionCount must be 2 (terrain area + secret-layer region)').toBe(2);
    expect(importResult.mapRouteCount, 'mapRouteCount must be 2 (linked route + secret route)').toBe(2);
    expect(importResult.mapLayerCount, 'mapLayerCount must be 2 (visible layer + secret layer)').toBe(2);
    expect(importResult.terrainTypeCount, 'terrainTypeCount must be 2 (grassland + hidden terrain)').toBe(2);

    const newUniverseId: string = importResult.universeId;

    // 15b. Fetch layers in the new universe — verifies secret layer survived import with secret=true
    //      and that IDs were remapped (layer-secrecy composition claim).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newLayersRes = await jsonReq('GET', `/api/universes/${newUniverseId}/map-layers`, { headers: hdrs });
    expect(newLayersRes.status).toBe(200);
    const newLayers: any[] = await json(newLayersRes);
    expect(newLayers, 'must have exactly 2 layers after import').toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newVisibleLayer = newLayers.find((l: any) => l.name === 'Terrain Layer');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newSecretLayerImported = newLayers.find((l: any) => l.name === 'Secret Layer');
    expect(newVisibleLayer, 'Terrain Layer must be found after import').toBeDefined();
    expect(newSecretLayerImported, 'Secret Layer must be found after import').toBeDefined();
    // CR-01 + WR-02: secret flag must survive import on the layer.
    expect(newSecretLayerImported.secret, 'Secret Layer must retain secret=true after import').toBe(true);
    // IDs must be remapped — secret layer gets a new UUID in the imported universe.
    expect(newSecretLayerImported.id, 'Secret Layer id must be remapped').not.toBe(secretLayer.id);

    // 16. Fetch re-imported maps; identify Map A and Map B by their distinct names.
    const newMapsRes = await jsonReq('GET', `/api/universes/${newUniverseId}/maps`, { headers: hdrs });
    expect(newMapsRes.status).toBe(200);
    const newMaps = await json(newMapsRes);
    expect(newMaps).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newMapA = newMaps.find((m: any) => m.name === 'Source Map A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newMapB = newMaps.find((m: any) => m.name === 'Target Map B');
    expect(newMapA, 'Source Map A must be found after import').toBeDefined();
    expect(newMapB, 'Target Map B must be found after import').toBeDefined();

    // 17. Fetch Map A detail for pin/region/route assertions.
    const mapADetailRes = await jsonReq(
      'GET',
      `/api/universes/${newUniverseId}/maps/${newMapA.id}`,
      { headers: hdrs },
    );
    expect(mapADetailRes.status).toBe(200);
    const mapADetail = await json(mapADetailRes);
    // WR-04: guard against endpoint regressions that silently drop these arrays —
    //        a TypeError on .find() gives a much worse diagnosis than a failing assertion here.
    expect(Array.isArray(mapADetail.routes), 'map detail must include routes array').toBe(true);
    expect(Array.isArray(mapADetail.pins), 'map detail must include pins array').toBe(true);
    expect(Array.isArray(mapADetail.regions), 'map detail must include regions array').toBe(true);

    // 18. Style intactness: linked route lineStyle/width/showArrow survive the round-trip.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newLinkedRoute = mapADetail.routes.find((r: any) => r.name === "King's Road");
    expect(newLinkedRoute, "linked route \"King's Road\" must be found after import").toBeDefined();
    expect(newLinkedRoute.lineStyle, 'lineStyle must be dashed').toBe('dashed');
    expect(newLinkedRoute.width, 'width must be 7').toBe(7);
    expect(newLinkedRoute.showArrow, 'showArrow must be true').toBe(true);
    // entryId remap: must be a new UUID, not the original entryA.id.
    expect(newLinkedRoute.entryId, 'route entryId must be remapped (non-null)').toBeTruthy();
    expect(newLinkedRoute.entryId, 'route entryId must not be the original entryA.id').not.toBe(entryA.id);

    // 18b. CR-02: Shadow Path (secret × route) — verify style fields AND secret flag survive import.
    //      The route is standalone (no entry link), so entryId must be null.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newShadowRoute = mapADetail.routes.find((r: any) => r.name === 'Shadow Path');
    expect(newShadowRoute, '"Shadow Path" secret route must be found after import').toBeDefined();
    expect(newShadowRoute.lineStyle, 'Shadow Path lineStyle must be dashed').toBe('dashed');
    expect(newShadowRoute.width, 'Shadow Path width must be 3').toBe(3);
    expect(newShadowRoute.showArrow, 'Shadow Path showArrow must be true').toBe(true);
    expect(newShadowRoute.entryId, 'Shadow Path is standalone — entryId must be null').toBeNull();
    // CR-01 + CR-02: secret flag must survive import on the route.
    expect(newShadowRoute.secret, 'Shadow Path must retain secret=true after import').toBe(true);

    // 19. Secret × targetMapId: secret pin must be PRESENT in the owner import (portability).
    //     The secret pin is the only pin on Map A with a non-null targetMapId.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newSecretPin = mapADetail.pins.find((p: any) => p.targetMapId !== null);
    expect(newSecretPin, 'secret pin (targetMapId != null) must be PRESENT in owner import').toBeDefined();
    // targetMapId must remap to new Map B's id — NOT the original mapB.id.
    expect(newSecretPin.targetMapId, 'secret pin targetMapId must equal new Map B id').toBe(newMapB.id);
    expect(newSecretPin.targetMapId, 'secret pin targetMapId must not be original Map B id').not.toBe(mapB.id);
    // CR-01: secret flag must survive import on the pin.
    expect(newSecretPin.secret, 'secret pin must retain secret=true after import').toBe(true);

    // 20. Layer-secrecy × map-to-map region: hidden territory must be PRESENT in the owner import.
    //     (Share-boundary filtering is SC2's job; the OWNER export sees all items regardless of secrecy.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newHiddenRegion = mapADetail.regions.find((r: any) => r.name === 'Hidden Territory');
    expect(newHiddenRegion, '"Hidden Territory" region must be PRESENT in owner import').toBeDefined();
    // targetMapId must remap to new Map B's id.
    expect(newHiddenRegion.targetMapId, 'region targetMapId must equal new Map B id').toBe(newMapB.id);
    expect(newHiddenRegion.targetMapId, 'region targetMapId must not be original Map B id').not.toBe(mapB.id);
    // WR-01: terrainTypeId under the secret layer must also be remapped — not nulled out.
    expect(
      newHiddenRegion.terrainTypeId,
      '"Hidden Territory" terrainTypeId must be remapped (non-null)',
    ).toBeTruthy();
    expect(
      newHiddenRegion.terrainTypeId,
      '"Hidden Territory" terrainTypeId must not be the original secretLayerTerrainType.id',
    ).not.toBe(secretLayerTerrainType.id);

    // 21. terrainTypeId remap: terrain area must reference a new terrainTypeId after import.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newGrassField = mapADetail.regions.find((r: any) => r.name === 'Grass Field');
    expect(newGrassField, '"Grass Field" terrain area must be present after import').toBeDefined();
    expect(newGrassField.terrainTypeId, 'terrainTypeId must be remapped (non-null)').toBeTruthy();
    expect(newGrassField.terrainTypeId, 'terrainTypeId must not be the original').not.toBe(terrainType.id);
  });
});
