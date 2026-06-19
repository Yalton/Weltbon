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
    opts: { entryId?: string | null; name?: string } = {},
  ) {
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);
    const res = await jsonReq(
      'POST',
      `/api/universes/${uid}/maps/${mapId}/regions`,
      { headers: hdrs, body: { name: opts.name ?? 'Test Region', points, entryId: opts.entryId ?? null } },
    );
    if (res.status !== 201) {
      throw new Error(`createRegion failed with status ${res.status}: ${await res.text()}`);
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
      // Deliberately NO maps/mapPins/mapRegions keys — backward-compat must default to []
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

    // No maps should appear in the imported universe.
    const mapsRes = await jsonReq('GET', `/api/universes/${result.universeId}/maps`, {
      headers: hdrs,
    });
    expect(mapsRes.status).toBe(200);
    const maps = await json(mapsRes);
    expect(maps).toHaveLength(0);
  });
});
