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
});
