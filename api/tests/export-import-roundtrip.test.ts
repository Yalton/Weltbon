/**
 * Phase 52 Plan 04 — SECRET-02 export→import round-trip integration tests.
 *
 * Covers:
 *   - T-52-09: secret=true items preserve their flag through export+import fidelity.
 *   - T-52-10: pre-v5.4 export (no `secret` key) imports cleanly with secret=false.
 *
 * Task 1 RED: Test that manifest.json in the exported ZIP includes `secret` on all
 *   four item types (pins, regions, routes, layers) — fails before payload.ts select
 *   blocks include `secret: mapPins.secret / mapRegions.secret / mapRoutes.secret`
 *   and json.ts manifest mappings include `secret: p.secret / r.secret / l.secret`.
 *
 * Task 2 RED: Tests that import preserves secret flags (round-trip) and handles
 *   missing secret keys gracefully (backward-compat). Both fail before import-json.ts
 *   gains `secret: z.boolean().optional().default(false)` in all four Zod schemas and
 *   `secret: item.secret` in all four insert loops.
 *
 * NOTE: UPLOADS_DIR must be set BEFORE importing createApp (same as other map tests).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bind storage to a temp dir BEFORE any import that pulls in the storageBackend singleton.
const UPLOADS_TMP = mkdtempSync(join(tmpdir(), 'weltbon-export-import-rt-'));
process.env.UPLOADS_DIR ??= UPLOADS_TMP;

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import yauzl from 'yauzl';
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

describe('export-import-roundtrip (SECRET-02)', () => {
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

  // ─── helpers ────────────────────────────────────────────────────────────────

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

  /** Upload a tiny PNG via multipart. Returns the asset JSON (id, mimeType, etc.). */
  async function uploadAsset(uid: string, hdrs: Record<string, string>) {
    const pngBytes = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 1 } },
    }).png().toBuffer();
    const fd = new FormData();
    fd.append('file', new Blob([pngBytes], { type: 'image/png' }), 'test.png');
    const res = await app.request(`http://localhost/api/universes/${uid}/assets`, {
      method: 'POST',
      headers: { ...hdrs },
      body: fd,
    });
    if (res.status !== 201) throw new Error(`uploadAsset failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  async function createUniverse(hdrs: Record<string, string>, name = 'SecretWorld') {
    const res = await jsonReq('POST', '/api/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, title = 'Test Entry') {
    const res = await jsonReq('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { title, entryType: 'concept', body: '', summary: '' },
    });
    return json(res);
  }

  async function createMap(uid: string, hdrs: Record<string, string>, imageAssetId: string) {
    const res = await jsonReq('POST', `/api/universes/${uid}/maps`, {
      headers: hdrs,
      body: { name: 'Test Map', imageAssetId },
    });
    if (res.status !== 201) throw new Error(`createMap failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  async function createPin(uid: string, mapId: string, entryId: string, hdrs: Record<string, string>) {
    const res = await jsonReq('POST', `/api/universes/${uid}/maps/${mapId}/pins`, {
      headers: hdrs,
      body: { entryId, x: 0.5, y: 0.5 },
    });
    if (res.status !== 201) throw new Error(`createPin failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  async function createRegion(
    uid: string, mapId: string, hdrs: Record<string, string>,
    opts: { entryId?: string | null; name?: string } = {},
  ) {
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]);
    const res = await jsonReq('POST', `/api/universes/${uid}/maps/${mapId}/regions`, {
      headers: hdrs,
      body: { name: opts.name ?? 'Test Region', points, entryId: opts.entryId ?? null },
    });
    if (res.status !== 201) throw new Error(`createRegion failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  async function createRoute(
    uid: string, mapId: string, hdrs: Record<string, string>,
    opts: { name?: string } = {},
  ) {
    const points = JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }]);
    const res = await jsonReq('POST', `/api/universes/${uid}/maps/${mapId}/routes`, {
      headers: hdrs,
      body: { name: opts.name ?? 'Test Route', points, lineStyle: 'solid', width: 4, showArrow: false },
    });
    if (res.status !== 201) throw new Error(`createRoute failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  async function createLayer(uid: string, hdrs: Record<string, string>, name = 'Test Layer') {
    const res = await jsonReq('POST', `/api/universes/${uid}/map-layers`, {
      headers: hdrs,
      body: { name },
    });
    if (res.status !== 201) throw new Error(`createLayer failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  /** Set pin.secret via PATCH /pins/:pinId/style */
  async function setPinSecret(
    uid: string, mapId: string, pinId: string, secret: boolean, hdrs: Record<string, string>,
  ) {
    const res = await jsonReq('PATCH', `/api/universes/${uid}/maps/${mapId}/pins/${pinId}/style`, {
      headers: hdrs,
      body: { secret },
    });
    if (res.status !== 200) throw new Error(`setPinSecret failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  /** Set region.secret via PATCH /regions/:regionId */
  async function setRegionSecret(
    uid: string, mapId: string, regionId: string, secret: boolean, hdrs: Record<string, string>,
  ) {
    const res = await jsonReq('PATCH', `/api/universes/${uid}/maps/${mapId}/regions/${regionId}`, {
      headers: hdrs,
      body: { secret },
    });
    if (res.status !== 200) throw new Error(`setRegionSecret failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  /** Set route.secret via PATCH /routes/:routeId */
  async function setRouteSecret(
    uid: string, mapId: string, routeId: string, secret: boolean, hdrs: Record<string, string>,
  ) {
    const res = await jsonReq('PATCH', `/api/universes/${uid}/maps/${mapId}/routes/${routeId}`, {
      headers: hdrs,
      body: { secret },
    });
    if (res.status !== 200) throw new Error(`setRouteSecret failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  /** Set layer.secret via PATCH /map-layers/:layerId */
  async function setLayerSecret(uid: string, layerId: string, secret: boolean, hdrs: Record<string, string>) {
    const res = await jsonReq('PATCH', `/api/universes/${uid}/map-layers/${layerId}`, {
      headers: hdrs,
      body: { secret },
    });
    if (res.status !== 200) throw new Error(`setLayerSecret failed: ${res.status}: ${await res.text()}`);
    return json(res);
  }

  /** Export as ZIP and return the bytes. */
  async function exportAsZip(uid: string, hdrs: Record<string, string>): Promise<Buffer> {
    const res = await app.request(`http://localhost/api/universes/${uid}/export?format=json`, {
      headers: hdrs,
    });
    if (res.status !== 200) throw new Error(`export failed: ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Extract manifest.json from a ZIP buffer using yauzl.
   * Returns the parsed manifest as a plain object.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function extractManifest(zipBytes: Buffer): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(zipBytes, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) return reject(err ?? new Error('yauzl.fromBuffer returned no zipfile'));

        zipfile.on('error', reject);

        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (entry.fileName !== 'manifest.json') {
            zipfile.readEntry();
            return;
          }
          zipfile.openReadStream(entry, (streamErr, rs) => {
            if (streamErr || !rs) return reject(streamErr ?? new Error('no readStream'));
            const chunks: Buffer[] = [];
            rs.on('data', (c: Buffer) => chunks.push(c));
            rs.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch (parseErr) { reject(parseErr); }
            });
            rs.on('error', reject);
          });
        });

        zipfile.on('end', () => reject(new Error('manifest.json not found in ZIP')));
        zipfile.readEntry();
      });
    });
  }

  /** Import a ZIP via multipart POST. Returns the result JSON. */
  async function importZip(zipBytes: Buffer, hdrs: Record<string, string>) {
    const fd = new FormData();
    fd.append('file', new Blob([zipBytes], { type: 'application/zip' }), 'universe.zip');
    const res = await app.request('http://localhost/api/universes/import', {
      method: 'POST',
      headers: { ...hdrs },
      body: fd,
    });
    return { status: res.status, body: await json(res) };
  }

  // ─── Task 1 RED: manifest JSON includes `secret` on all four item types ──────
  // This test fails before payload.ts select blocks include secret: mapPins.secret /
  // mapRegions.secret / mapRoutes.secret and json.ts manifest mappings include
  // secret: p.secret / r.secret / l.secret.

  it('exported manifest.json includes secret on pins, regions, routes, and layers', async () => {
    const { hdrs } = await userWithToken('rt-manifest-secret@test.com');
    const universe = await createUniverse(hdrs, 'ManifestSecretWorld');

    const asset = await uploadAsset(universe.id, hdrs);
    const entry = await createEntry(universe.id, hdrs, 'Secret Entry');
    const map = await createMap(universe.id, hdrs, asset.id);
    const layer = await createLayer(universe.id, hdrs, 'Secret Layer');

    // Create a secret pin and a non-secret pin.
    const secretPin = await createPin(universe.id, map.id, entry.id, hdrs);
    await setPinSecret(universe.id, map.id, secretPin.id, true, hdrs);

    const publicEntry = await createEntry(universe.id, hdrs, 'Public Entry');
    const publicPin = await createPin(universe.id, map.id, publicEntry.id, hdrs);
    // publicPin stays secret=false (default)

    // Create a secret region.
    const secretRegion = await createRegion(universe.id, map.id, hdrs, { name: 'Secret Region' });
    await setRegionSecret(universe.id, map.id, secretRegion.id, true, hdrs);

    // Create a secret route.
    const secretRoute = await createRoute(universe.id, map.id, hdrs, { name: 'Secret Route' });
    await setRouteSecret(universe.id, map.id, secretRoute.id, true, hdrs);

    // Create a secret layer.
    await setLayerSecret(universe.id, layer.id, true, hdrs);

    // Export as ZIP and extract manifest.
    const zipBytes = await exportAsZip(universe.id, hdrs);
    const manifest = await extractManifest(zipBytes);

    // Assert: the manifest includes `secret` on all four item types.

    // Pins: secret pin has secret=true, public pin has secret=false.
    const mPin = manifest.mapPins.find((p: any) => p.id === secretPin.id);
    const mPublicPin = manifest.mapPins.find((p: any) => p.id === publicPin.id);
    expect(mPin, 'secret pin must appear in manifest').toBeDefined();
    expect(mPin.secret, 'secret pin must have secret=true in manifest').toBe(true);
    expect(mPublicPin.secret, 'public pin must have secret=false in manifest').toBe(false);

    // Regions: secret region has secret=true.
    const mRegion = manifest.mapRegions.find((r: any) => r.id === secretRegion.id);
    expect(mRegion, 'secret region must appear in manifest').toBeDefined();
    expect(mRegion.secret, 'secret region must have secret=true in manifest').toBe(true);

    // Routes: secret route has secret=true.
    const mRoute = manifest.mapRoutes.find((r: any) => r.id === secretRoute.id);
    expect(mRoute, 'secret route must appear in manifest').toBeDefined();
    expect(mRoute.secret, 'secret route must have secret=true in manifest').toBe(true);

    // Layers: secret layer has secret=true.
    const mLayer = manifest.mapLayers.find((l: any) => l.id === layer.id);
    expect(mLayer, 'secret layer must appear in manifest').toBeDefined();
    expect(mLayer.secret, 'secret layer must have secret=true in manifest').toBe(true);
  });

  // ─── Task 2 RED: round-trip preserves secret flags ──────────────────────────
  // This test fails before import-json.ts gains:
  //   secret: z.boolean().optional().default(false) in all four Zod schemas
  //   secret: item.secret in all four insert loops.

  it('secret flags round-trip through export→import with full fidelity (T-52-09)', async () => {
    const { hdrs } = await userWithToken('rt-fidelity-secret@test.com');
    const universe = await createUniverse(hdrs, 'RoundTripSecretWorld');

    const asset = await uploadAsset(universe.id, hdrs);
    const entry1 = await createEntry(universe.id, hdrs, 'Secret Entry');
    const entry2 = await createEntry(universe.id, hdrs, 'Public Entry');
    const map = await createMap(universe.id, hdrs, asset.id);

    // Create one secret and one non-secret of each type.

    // Pins
    const secretPin = await createPin(universe.id, map.id, entry1.id, hdrs);
    await setPinSecret(universe.id, map.id, secretPin.id, true, hdrs);
    const publicPin = await createPin(universe.id, map.id, entry2.id, hdrs);
    // publicPin stays secret=false

    // Regions
    const secretRegion = await createRegion(universe.id, map.id, hdrs, { name: 'Secret Region' });
    await setRegionSecret(universe.id, map.id, secretRegion.id, true, hdrs);
    const publicRegion = await createRegion(universe.id, map.id, hdrs, { name: 'Public Region' });

    // Routes
    const secretRoute = await createRoute(universe.id, map.id, hdrs, { name: 'Secret Route' });
    await setRouteSecret(universe.id, map.id, secretRoute.id, true, hdrs);
    const publicRoute = await createRoute(universe.id, map.id, hdrs, { name: 'Public Route' });

    // Layers
    const secretLayer = await createLayer(universe.id, hdrs, 'Secret Layer');
    await setLayerSecret(universe.id, secretLayer.id, true, hdrs);
    const publicLayer = await createLayer(universe.id, hdrs, 'Public Layer');

    // Export + import.
    const zipBytes = await exportAsZip(universe.id, hdrs);
    const { status, body: importResult } = await importZip(zipBytes, hdrs);
    expect(status, `import failed: ${JSON.stringify(importResult)}`).toBe(201);

    const newUid: string = importResult.universeId;

    // Fetch the re-imported map detail.
    const newMapsRes = await jsonReq('GET', `/api/universes/${newUid}/maps`, { headers: hdrs });
    expect(newMapsRes.status).toBe(200);
    const newMaps = await json(newMapsRes);
    expect(newMaps).toHaveLength(1);

    const mapDetailRes = await jsonReq(
      'GET', `/api/universes/${newUid}/maps/${newMaps[0].id}`, { headers: hdrs },
    );
    expect(mapDetailRes.status).toBe(200);
    const mapDetail = await json(mapDetailRes);

    // Pins: find by original entry titles (entry IDs are remapped, but titles survive).
    // The imported entries are queryable by fetching the entries list.
    const entriesRes = await jsonReq('GET', `/api/universes/${newUid}/entries`, { headers: hdrs });
    expect(entriesRes.status).toBe(200);
    const importedEntries = await json(entriesRes);
    const secretEntryId = importedEntries.find((e: any) => e.title === 'Secret Entry')?.id;
    const publicEntryId = importedEntries.find((e: any) => e.title === 'Public Entry')?.id;
    expect(secretEntryId, 'secret entry must be found in imported universe').toBeTruthy();
    expect(publicEntryId, 'public entry must be found in imported universe').toBeTruthy();

    const importedSecretPin = mapDetail.pins.find((p: any) => p.entryId === secretEntryId);
    const importedPublicPin = mapDetail.pins.find((p: any) => p.entryId === publicEntryId);
    expect(importedSecretPin, 'imported secret pin must exist').toBeDefined();
    expect(importedPublicPin, 'imported public pin must exist').toBeDefined();
    expect(importedSecretPin.secret, 'imported secret pin must have secret=true').toBe(true);
    expect(importedPublicPin.secret, 'imported public pin must have secret=false').toBe(false);

    // Regions: find by name.
    const importedSecretRegion = mapDetail.regions.find((r: any) => r.name === 'Secret Region');
    const importedPublicRegion = mapDetail.regions.find((r: any) => r.name === 'Public Region');
    expect(importedSecretRegion, 'imported secret region must exist').toBeDefined();
    expect(importedPublicRegion, 'imported public region must exist').toBeDefined();
    expect(importedSecretRegion.secret, 'imported secret region must have secret=true').toBe(true);
    expect(importedPublicRegion.secret, 'imported public region must have secret=false').toBe(false);

    // Routes: find by name.
    const importedSecretRoute = mapDetail.routes.find((r: any) => r.name === 'Secret Route');
    const importedPublicRoute = mapDetail.routes.find((r: any) => r.name === 'Public Route');
    expect(importedSecretRoute, 'imported secret route must exist').toBeDefined();
    expect(importedPublicRoute, 'imported public route must exist').toBeDefined();
    expect(importedSecretRoute.secret, 'imported secret route must have secret=true').toBe(true);
    expect(importedPublicRoute.secret, 'imported public route must have secret=false').toBe(false);

    // Layers: fetch via /map-layers endpoint and find by name.
    const layersRes = await jsonReq('GET', `/api/universes/${newUid}/map-layers`, { headers: hdrs });
    expect(layersRes.status).toBe(200);
    const importedLayers = await json(layersRes);
    const importedSecretLayer = importedLayers.find((l: any) => l.name === 'Secret Layer');
    const importedPublicLayer = importedLayers.find((l: any) => l.name === 'Public Layer');
    expect(importedSecretLayer, 'imported secret layer must exist').toBeDefined();
    expect(importedPublicLayer, 'imported public layer must exist').toBeDefined();
    expect(importedSecretLayer.secret, 'imported secret layer must have secret=true').toBe(true);
    expect(importedPublicLayer.secret, 'imported public layer must have secret=false').toBe(false);
  });

  // ─── Task 2 RED: backward-compat — pre-v5.4 export (no secret key) ──────────
  // Asserts that a hand-crafted payload without `secret` keys on any item imports
  // cleanly with secret=false for all items and does not crash (T-52-10).

  it('pre-v5.4 export without secret keys imports cleanly, all items default to secret=false (T-52-10)', async () => {
    const { hdrs } = await userWithToken('rt-compat-secret@test.com');

    const mapId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const pinEntryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const layerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    // Hand-craft a pre-v5.4 payload that omits `secret` entirely from all item types.
    const preV54Payload = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'PreSecretWorld', description: 'Pre-v5.4 export without secret keys' },
      entries: [
        {
          id: pinEntryId,
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
      maps: [{ id: mapId, name: 'Old Map', imageAssetId: null, legendLabels: null }],
      mapPins: [
        // NO `secret` field — simulates pre-v5.4 export
        { mapId, entryId: pinEntryId, x: 0.5, y: 0.5 },
      ],
      mapRegions: [
        // NO `secret` field
        {
          mapId,
          entryId: null,
          name: 'Old Region',
          points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.5 }]),
          color: null,
        },
      ],
      mapRoutes: [
        // NO `secret` field
        {
          mapId,
          entryId: null,
          name: 'Old Route',
          points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }]),
          lineStyle: 'solid',
          width: 4,
          showArrow: false,
        },
      ],
      mapLayers: [
        // NO `secret` field
        { id: layerId, name: 'Old Layer', ordered: false, defaultOpacity: 0.6, sortOrder: 0 },
      ],
      terrainTypes: [],
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: preV54Payload,
    });
    expect(res.status, `pre-v5.4 import must succeed (201), got: ${res.status}`).toBe(201);
    const importResult = await json(res);
    expect(importResult.mapPinCount, 'one pin imported').toBe(1);
    expect(importResult.mapRegionCount, 'one region imported').toBe(1);
    expect(importResult.mapRouteCount, 'one route imported').toBe(1);
    expect(importResult.mapLayerCount, 'one layer imported').toBe(1);

    const newUid: string = importResult.universeId;

    // Verify all items defaulted to secret=false.
    const newMapsRes = await jsonReq('GET', `/api/universes/${newUid}/maps`, { headers: hdrs });
    expect(newMapsRes.status).toBe(200);
    const newMaps = await json(newMapsRes);
    expect(newMaps).toHaveLength(1);

    const mapDetailRes = await jsonReq(
      'GET', `/api/universes/${newUid}/maps/${newMaps[0].id}`, { headers: hdrs },
    );
    expect(mapDetailRes.status).toBe(200);
    const mapDetail = await json(mapDetailRes);

    expect(mapDetail.pins).toHaveLength(1);
    expect(mapDetail.pins[0].secret, 'pin must default to secret=false').toBe(false);

    expect(mapDetail.regions).toHaveLength(1);
    expect(mapDetail.regions[0].secret, 'region must default to secret=false').toBe(false);

    expect(mapDetail.routes).toHaveLength(1);
    expect(mapDetail.routes[0].secret, 'route must default to secret=false').toBe(false);

    const layersRes = await jsonReq('GET', `/api/universes/${newUid}/map-layers`, { headers: hdrs });
    expect(layersRes.status).toBe(200);
    const importedLayers = await json(layersRes);
    expect(importedLayers).toHaveLength(1);
    expect(importedLayers[0].secret, 'layer must default to secret=false').toBe(false);
  });
});
