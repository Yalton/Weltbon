
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bind storage to a temp dir BEFORE any import that pulls in the storageBackend singleton.
const UPLOADS_TMP = mkdtempSync(join(tmpdir(), 'weltbon-import-export-assets-'));
process.env.UPLOADS_DIR = UPLOADS_TMP;

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/index.js';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  authHeader,
  type TestDbHandle,
} from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb, db } from '../src/db/client.js';
import { entries } from '../src/db/schema.js';
import { storageBackend } from '../src/services/storage/local.js';

describe('import-export-assets (MEDIA-06)', () => {
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

  async function createUniverse(hdrs: Record<string, string>, name = 'AssetWorld') {
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

  /** Set an entry's coverImageId directly via the database (for test setup). */
  async function setCover(entryId: string, assetId: string) {
    await db().update(entries).set({ coverImageId: assetId }).where(eq(entries.id, entryId));
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

  // ─── MEDIA-06 Round-trip test ────────────────────────────────────────────────

  it('exports ZIP + reimports: cover + inline asset refs are restored and remapped', async () => {
    const { hdrs } = await userWithToken('media06-rt@test.com');
    const universe = await createUniverse(hdrs, 'MEDIA06World');

    // 1. Upload two assets: one for cover, one for inline embed.
    const coverAsset = await uploadAsset(universe.id, hdrs);
    const inlineAsset = await uploadAsset(universe.id, hdrs);

    // 2. Create an entry with the cover asset + another entry with inline embed.
    const coverEntry = await createEntry(universe.id, hdrs, {
      title: 'Entry With Cover',
      body: '',
    });
    await setCover(coverEntry.id, coverAsset.id);

    const inlineEntry = await createEntry(universe.id, hdrs, {
      title: 'Entry With Inline',
      body: `![alt text](asset://${inlineAsset.id})`,
    });

    // 3. Export as ZIP.
    const zipBytes = await exportAsZip(universe.id, hdrs);
    expect(zipBytes.length).toBeGreaterThan(0);

    // 4. Import the ZIP (creates a new universe with new UUIDs).
    const { status, body: importResult } = await importZip(zipBytes, hdrs);
    expect(status, `import failed: ${JSON.stringify(importResult)}`).toBe(201);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(importResult.assetCount).toBe(2);
    expect(importResult.entryCount).toBe(2);

    const newUniverseId: string = importResult.universeId;

    // 5. List entries in the new universe (list response includes coverImageId but not body).
    const entriesRes = await jsonReq('GET', `/api/universes/${newUniverseId}/entries`, {
      headers: hdrs,
    });
    expect(entriesRes.status).toBe(200);
    const entriesList = await json(entriesRes);

    const newCoverEntryStub = entriesList.find((e: any) => e.title === 'Entry With Cover');
    const newInlineEntryStub = entriesList.find((e: any) => e.title === 'Entry With Inline');
    expect(newCoverEntryStub, 'cover entry not found in new universe').toBeTruthy();
    expect(newInlineEntryStub, 'inline entry not found in new universe').toBeTruthy();

    // 6. Assert cover entry has a new (remapped) coverImageId that is not the original.
    expect(newCoverEntryStub.coverImageId, 'imported entry should have coverImageId').toBeTruthy();
    expect(newCoverEntryStub.coverImageId).not.toBe(coverAsset.id); // remapped to new UUID

    // 7. Assert the cover asset's bytes are retrievable in the new universe.
    const rawRes = await app.request(
      `http://localhost/api/universes/${newUniverseId}/assets/${newCoverEntryStub.coverImageId}/raw`,
      { headers: hdrs },
    );
    expect(rawRes.status, 'cover asset bytes not retrievable after import').toBe(200);
    expect(rawRes.headers.get('content-type')).toBe('image/png');

    // 8. Fetch the inline entry individually to get the body field (list omits body for size).
    const inlineEntryRes = await jsonReq(
      'GET',
      `/api/universes/${newUniverseId}/entries/${newInlineEntryStub.id}`,
      { headers: hdrs },
    );
    expect(inlineEntryRes.status).toBe(200);
    const newInlineEntry = await json(inlineEntryRes);

    // Assert the inline body ref was remapped: asset://oldId → asset://newId.
    const inlineBody: string = newInlineEntry.body;
    expect(inlineBody, 'body should contain asset:// ref').toMatch(/asset:\/\//);
    // Must NOT reference the original asset ID.
    expect(inlineBody).not.toContain(inlineAsset.id);
    // Extract the new UUID from the body.
    const match = inlineBody.match(/asset:\/\/([a-f0-9-]+)/);
    expect(match, 'could not extract UUID from body').toBeTruthy();
    const newInlineAssetId = match![1];
    expect(newInlineAssetId).not.toBe(inlineAsset.id);

    // 9. Assert the inline asset's bytes are retrievable via the new UUID.
    const inlineRawRes = await app.request(
      `http://localhost/api/universes/${newUniverseId}/assets/${newInlineAssetId}/raw`,
      { headers: hdrs },
    );
    expect(inlineRawRes.status, 'inline asset bytes not retrievable after import').toBe(200);

    // 10. Assert the new asset IDs are different from the originals (IDs are remapped).
    const assetsRes = await jsonReq('GET', `/api/universes/${newUniverseId}/assets`, {
      headers: hdrs,
    });
    const newAssets = await json(assetsRes);
    expect(newAssets).toHaveLength(2);
    const newIds = newAssets.map((a: any) => a.id);
    expect(newIds).not.toContain(coverAsset.id);
    expect(newIds).not.toContain(inlineAsset.id);

    // 11. The cover asset's bytes in StorageBackend are identical to the original.
    const origBytes = await storageBackend.get(coverAsset.id);
    const restoredBytes = await storageBackend.get(newCoverEntryStub.coverImageId);
    expect(origBytes).not.toBeNull();
    expect(restoredBytes).not.toBeNull();
    expect(restoredBytes!.length).toBe(origBytes!.length);
  });

  // ─── Legacy compat test ──────────────────────────────────────────────────────

  it('imports legacy plain-JSON (version 1.0.0, no assets key) successfully', async () => {
    const { hdrs } = await userWithToken('media06-legacy@test.com');

    const legacyPayload = {
      weltbon_version: '1.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'LegacyImport', description: 'Old format' },
      entries: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Legacy Entry',
          entryType: 'concept',
          summary: '',
          body: 'No assets here',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
        },
      ],
      links: [],
      // Deliberately NO 'assets' key — backward-compat must default to []
    };

    const res = await jsonReq('POST', '/api/universes/import', {
      headers: hdrs,
      body: legacyPayload,
    });
    expect(res.status, 'legacy import should succeed with 201').toBe(201);
    const result = await json(res);
    expect(result.universeName).toBe('LegacyImport');
    expect(result.entryCount).toBe(1);
    // assetCount should be 0 (no assets in legacy format)
    expect(result.assetCount ?? 0).toBe(0);

    // The imported universe should have no assets.
    const assetsRes = await jsonReq('GET', `/api/universes/${result.universeId}/assets`, {
      headers: hdrs,
    });
    const assets = await json(assetsRes);
    expect(assets).toHaveLength(0);
  });
});
