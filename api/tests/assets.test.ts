
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bind storage to a temp dir BEFORE any import pulls in the storageBackend singleton.
const UPLOADS_TMP = mkdtempSync(join(tmpdir(), 'weltbon-assets-'));
process.env.UPLOADS_DIR = UPLOADS_TMP;
// Shrink the quota so the over-quota path (MEDIA-02) is reachable. A single noisy
// 256x256 PNG re-encodes to ~190KB; a 250KB cap lets the first upload through and
// rejects the second (cumulative SUM > cap) → deterministic 413.
process.env.MEDIA_UNIVERSE_QUOTA_BYTES = String(250 * 1024);

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { entries } from '../src/db/schema.js';

describe('asset routes (MEDIA-01/02/03/04)', () => {
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
    opts?: { headers?: Record<string, string>; body?: unknown }
  ) {
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(`http://localhost${path}`, init);
  }

  async function uploadReq(
    path: string,
    file: { bytes: Buffer; filename: string; mime: string },
    hdrs: Record<string, string>
  ) {
    const fd = new FormData();
    const blob = new Blob([file.bytes], { type: file.mime });
    fd.append('file', blob, file.filename);
    // Do NOT set Content-Type — the runtime sets multipart boundary automatically.
    return app.request(`http://localhost${path}`, { method: 'POST', headers: { ...hdrs }, body: fd });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  async function createUniverse(hdrs: Record<string, string>, name = 'MediaWorld') {
    const res = await jsonReq('POST', '/api/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(
    uid: string,
    hdrs: Record<string, string>,
    overrides: Record<string, unknown> = {}
  ) {
    const res = await jsonReq('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { title: 'Test Entry', entryType: 'concept', ...overrides },
    });
    return json(res);
  }

  async function makePng(width = 8, height = 8): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 100, g: 150, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }

  /**
   * A high-entropy PNG that does NOT compress well (~190KB re-encoded), so the
   * per-universe quota path (MEDIA-02) is reachable with a tiny, deterministic cap.
   */
  async function makeNoisyPng(width = 256, height = 256): Promise<Buffer> {
    // crypto.randomBytes gives genuinely high-entropy pixels — PNG cannot compress
    // them, so the re-encode stays ~190KB (an LCG's low byte is too periodic and
    // would compress to ~10KB, defeating the quota test).
    const raw = randomBytes(width * height * 3);
    return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }

  // ─── MEDIA-01: upload + stable serving URL ──────────────────────────────────

  it('uploads a valid PNG → 201 with id/rawUrl/thumbUrl; GET /raw returns the bytes', async () => {
    const { hdrs } = await userWithToken('a@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();

    const res = await uploadReq(
      `/api/universes/${universe.id}/assets`,
      { bytes: png, filename: 'hero.png', mime: 'image/png' },
      hdrs
    );
    expect(res.status).toBe(201);
    const asset = await json(res);
    expect(asset.id).toBeTruthy();
    expect(asset.mimeType).toBe('image/png');
    expect(asset.extension).toBe('png');
    expect(asset.filename).toBe('hero.png');
    expect(asset.sizeBytes).toBeGreaterThan(0);
    expect(asset.thumbSizeBytes).toBeGreaterThan(0);

    expect(asset.rawUrl).toContain(`/api/universes/${universe.id}/assets/${asset.id}/raw`);
    expect(asset.rawUrl).toContain('?e=');
    expect(asset.rawUrl).toContain('&s=');
    expect(asset.thumbUrl).toContain(`/api/universes/${universe.id}/assets/${asset.id}/thumb`);
    expect(asset.thumbUrl).toContain('?e=');
    expect(asset.thumbUrl).toContain('&s=');

    // GET /raw → 200 image bytes with the stored mimeType
    const rawRes = await app.request(`http://localhost${asset.rawUrl}`, { headers: hdrs });
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get('content-type')).toBe('image/png');
    const rawBytes = Buffer.from(await rawRes.arrayBuffer());
    expect(rawBytes.length).toBe(asset.sizeBytes);


    // bytes — the post-sharp re-encode served by /raw — not of the thumbnail.
    expect(asset.contentHash).toBe(createHash('sha256').update(rawBytes).digest('hex'));

    // GET /thumb → 200 (thumbnail key exists)
    const thumbRes = await app.request(`http://localhost${asset.thumbUrl}`, { headers: hdrs });
    expect(thumbRes.status).toBe(200);
    const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
    expect(thumbBytes.length).toBe(asset.thumbSizeBytes);
  });

  // ─── MEDIA-02: validation (magic-number, quota, thumbnail) ──────────────────

  it('rejects an SVG via magic-number sniff → 415, no asset row created', async () => {
    const { hdrs } = await userWithToken('b@test.com');
    const universe = await createUniverse(hdrs);
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    );

    const res = await uploadReq(
      `/api/universes/${universe.id}/assets`,
      { bytes: svg, filename: 'evil.svg', mime: 'image/png' }, // claimed mime is a lie
      hdrs
    );
    expect(res.status).toBe(415);

    // No bytes written → list is empty
    const listRes = await jsonReq('GET', `/api/universes/${universe.id}/assets`, { headers: hdrs });
    const list = await json(listRes);
    expect(list.length).toBe(0);
  });

  it('rejects an upload that would exceed the universe quota → 413', async () => {
    const { hdrs } = await userWithToken('c@test.com');
    const universe = await createUniverse(hdrs);
    // Quota is shrunk to 250KB via env (top of file). A noisy 256x256 PNG
    // re-encodes to ~190KB, so the first upload fits and the second exceeds.
    const big = await makeNoisyPng();

    const first = await uploadReq(
      `/api/universes/${universe.id}/assets`,
      { bytes: big, filename: 'one.png', mime: 'image/png' },
      hdrs
    );
    expect(first.status).toBe(201); // first fits under the cap, bytes written

    const second = await uploadReq(
      `/api/universes/${universe.id}/assets`,
      { bytes: big, filename: 'two.png', mime: 'image/png' },
      hdrs
    );
    // Cumulative SUM(size_bytes) + incoming > cap → rejected BEFORE writing bytes.
    expect(second.status).toBe(413);

    // The over-quota upload must NOT have created a row (no bytes written).
    const listRes = await jsonReq('GET', `/api/universes/${universe.id}/assets`, { headers: hdrs });
    const list = await json(listRes);
    expect(list.length).toBe(1);
  });

  // ─── MEDIA-03: list / rename / delete-with-refs (D-12) ──────────────────────

  it('lists assets (bare array) and renames an asset', async () => {
    const { hdrs } = await userWithToken('d@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const up = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'orig.png', mime: 'image/png' },
        hdrs
      )
    );

    const listRes = await jsonReq('GET', `/api/universes/${universe.id}/assets`, { headers: hdrs });
    expect(listRes.status).toBe(200);
    const list = await json(listRes);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(up.id);

    const renameRes = await jsonReq('PATCH', `/api/universes/${universe.id}/assets/${up.id}`, {
      headers: hdrs,
      body: { filename: 'renamed.png' },
    });
    expect(renameRes.status).toBe(200);
    const renamed = await json(renameRes);
    expect(renamed.filename).toBe('renamed.png');
  });

  it('delete of a referenced asset surfaces usage and nulls the cover ref (D-12)', async () => {
    const { hdrs } = await userWithToken('e@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'cover.png', mime: 'image/png' },
        hdrs
      )
    );

    // One entry uses the asset as a cover; another embeds it inline in the body.
    const coverEntry = await createEntry(universe.id, hdrs, { title: 'Has Cover' });
    const inlineEntry = await createEntry(universe.id, hdrs, {
      title: 'Has Inline',
      body: `Look: ![pic](asset://${asset.id})`,
    });
    // Set the cover ref directly (the entries API does not expose coverImageId yet).
    await handle.db
      .update(entries)
      .set({ coverImageId: asset.id })
      .where(eq(entries.id, coverEntry.id));

    // Usage pre-check surfaces both references (D-12 warning).
    const usageRes = await jsonReq('GET', `/api/universes/${universe.id}/assets/${asset.id}/usage`, {
      headers: hdrs,
    });
    expect(usageRes.status).toBe(200);
    const usage = await json(usageRes);
    expect(usage.count).toBe(2);
    const kinds = usage.references.map((r: any) => r.kind).sort();
    expect(kinds).toEqual(['cover', 'inline']);

    // Delete → 204; cover ref nulled, inline body ref left intact.
    const delRes = await jsonReq('DELETE', `/api/universes/${universe.id}/assets/${asset.id}`, {
      headers: hdrs,
    });
    expect(delRes.status).toBe(204);

    const [coverRow] = await handle.db
      .select({ coverImageId: entries.coverImageId, body: entries.body })
      .from(entries)
      .where(eq(entries.id, coverEntry.id));
    expect(coverRow.coverImageId).toBeNull(); // D-12: cover ref nulled

    const [inlineRow] = await handle.db
      .select({ body: entries.body })
      .from(entries)
      .where(eq(entries.id, inlineEntry.id));
    expect(inlineRow.body).toContain(`asset://${asset.id}`); // D-12: inline ref preserved

    // Asset row is gone → list empty.
    const listRes = await jsonReq('GET', `/api/universes/${universe.id}/assets`, { headers: hdrs });
    const list = await json(listRes);
    expect(list.length).toBe(0);
  });

  // ─── MEDIA-04: cover image persistence ──────────────────────────────────────

  it('persists entries.coverImageId set via the entries API (CR-01 fix)', async () => {
    const { hdrs } = await userWithToken('f@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'banner.png', mime: 'image/png' },
        hdrs
      )
    );

    // Create entry with coverImageId via the API (CR-01: entries API now accepts it).
    const entry = await createEntry(universe.id, hdrs, {
      title: 'Cover Bearer API',
      coverImageId: asset.id,
    });
    expect(entry.coverImageId).toBe(asset.id);

    // PATCH to clear the cover (explicit null must clear the FK).
    const patchRes = await jsonReq('PATCH', `/api/universes/${universe.id}/entries/${entry.id}`, {
      headers: hdrs,
      body: { coverImageId: null },
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.coverImageId).toBeNull();

    // PATCH to set cover again.
    const patchRes2 = await jsonReq('PATCH', `/api/universes/${universe.id}/entries/${entry.id}`, {
      headers: hdrs,
      body: { coverImageId: asset.id },
    });
    expect(patchRes2.status).toBe(200);
    const patched2 = await json(patchRes2);
    expect(patched2.coverImageId).toBe(asset.id);
  });

  // ─── Auth boundary (T-38-14) ────────────────────────────────────────────────

  it('blocks cross-tenant asset listing → 403', async () => {
    const { hdrs: ownerHdrs } = await userWithToken('owner@test.com');
    const { hdrs: attackerHdrs } = await userWithToken('attacker@test.com');
    const universe = await createUniverse(ownerHdrs);

    const res = await jsonReq('GET', `/api/universes/${universe.id}/assets`, {
      headers: attackerHdrs,
    });
    expect(res.status).toBe(403);
  });

  it('returns 401 for unauthenticated asset listing', async () => {
    const { hdrs } = await userWithToken('g@test.com');
    const universe = await createUniverse(hdrs);

    const res = await jsonReq('GET', `/api/universes/${universe.id}/assets`);
    expect(res.status).toBe(401);
  });



  it('GET /raw with NO Authorization header but a VALID signature → 200 + correct Content-Type', async () => {
    const { hdrs } = await userWithToken('signed-url-a@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'signed.png', mime: 'image/png' },
        hdrs
      )
    );
    // The upload response rawUrl now includes ?e=&s= query params.
    expect(asset.rawUrl).toContain('?e=');
    expect(asset.rawUrl).toContain('&s=');

    // Fetch the signed rawUrl WITHOUT any Authorization header — should be 200.
    const res = await app.request(`http://localhost${asset.rawUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBe(asset.sizeBytes);
  });

  it('GET /raw with a tampered signature → 401', async () => {
    const { hdrs } = await userWithToken('signed-url-b@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'tamper.png', mime: 'image/png' },
        hdrs
      )
    );
    // Build a tampered URL by replacing the signature with junk.
    const tamperedUrl = asset.rawUrl.replace(/s=[^&]+/, 's=0000000000000000000000000000000000000000000000000000000000000000');
    const res = await app.request(`http://localhost${tamperedUrl}`);
    expect(res.status).toBe(401);
  });

  it('GET /raw with an expired signature → 401', async () => {
    const { hdrs } = await userWithToken('signed-url-c@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'expired.png', mime: 'image/png' },
        hdrs
      )
    );
    // Build an expired URL: set e= to a past epoch (1 second before now).
    const expiredEpoch = Math.floor(Date.now() / 1000) - 1;
    const expiredUrl = asset.rawUrl.replace(/e=\d+/, `e=${expiredEpoch}`);
    // The sig is now invalid for the new e= value too — but expiry alone should reject.
    const res = await app.request(`http://localhost${expiredUrl}`);
    expect(res.status).toBe(401);
  });

  it('GET /thumb with valid signature → 200 (thumb serving also works without bearer)', async () => {
    const { hdrs } = await userWithToken('signed-url-d@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'sig-thumb.png', mime: 'image/png' },
        hdrs
      )
    );
    expect(asset.thumbUrl).toContain('?e=');
    expect(asset.thumbUrl).toContain('&s=');

    const res = await app.request(`http://localhost${asset.thumbUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('upload response and list rawUrl/thumbUrl contain ?e= and &s= signed params', async () => {
    const { hdrs } = await userWithToken('signed-url-e@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();

    // Upload: response rawUrl/thumbUrl should be signed.
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'list-signed.png', mime: 'image/png' },
        hdrs
      )
    );
    expect(asset.rawUrl).toContain('?e=');
    expect(asset.rawUrl).toContain('&s=');
    expect(asset.thumbUrl).toContain('?e=');
    expect(asset.thumbUrl).toContain('&s=');

    // List: array items should also include signed rawUrl/thumbUrl.
    const listRes = await jsonReq('GET', `/api/universes/${universe.id}/assets`, { headers: hdrs });
    const list = await json(listRes);
    expect(list.length).toBe(1);
    expect(list[0].rawUrl).toContain('?e=');
    expect(list[0].rawUrl).toContain('&s=');
    expect(list[0].thumbUrl).toContain('?e=');
    expect(list[0].thumbUrl).toContain('&s=');
  });

  it('entry detail coverImageUrl is a signed URL when entry has a cover image', async () => {
    const { hdrs } = await userWithToken('signed-url-f@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'cover-signed.png', mime: 'image/png' },
        hdrs
      )
    );

    // Create entry with cover image.
    const entry = await createEntry(universe.id, hdrs, {
      title: 'Cover Entry',
      coverImageId: asset.id,
    });

    // Fetch entry detail.
    const detailRes = await jsonReq('GET', `/api/universes/${universe.id}/entries/${entry.id}`, {
      headers: hdrs,
    });
    expect(detailRes.status).toBe(200);
    const detail = await json(detailRes);
    expect(detail.coverImageUrl).toBeTruthy();
    expect(detail.coverImageUrl).toContain(asset.id);
    expect(detail.coverImageUrl).toContain('?e=');
    expect(detail.coverImageUrl).toContain('&s=');
    // Verify the signed coverImageUrl works without bearer.
    const imgRes = await app.request(`http://localhost${detail.coverImageUrl}`);
    expect(imgRes.status).toBe(200);
  });

  it('entry detail assetUrls map contains signed URLs for asset:// embeds in body', async () => {
    const { hdrs } = await userWithToken('signed-url-g@test.com');
    const universe = await createUniverse(hdrs);
    const png = await makePng();
    const asset = await json(
      await uploadReq(
        `/api/universes/${universe.id}/assets`,
        { bytes: png, filename: 'embed.png', mime: 'image/png' },
        hdrs
      )
    );

    const entry = await createEntry(universe.id, hdrs, {
      title: 'Inline Entry',
      body: `Look: ![pic](asset://${asset.id})`,
    });

    const detailRes = await jsonReq('GET', `/api/universes/${universe.id}/entries/${entry.id}`, {
      headers: hdrs,
    });
    expect(detailRes.status).toBe(200);
    const detail = await json(detailRes);
    expect(detail.assetUrls).toBeDefined();
    expect(detail.assetUrls[asset.id]).toBeTruthy();
    expect(detail.assetUrls[asset.id]).toContain('?e=');
    expect(detail.assetUrls[asset.id]).toContain('&s=');
    // Verify the signed embed URL works without bearer.
    const imgRes = await app.request(`http://localhost${detail.assetUrls[asset.id]}`);
    expect(imgRes.status).toBe(200);
  });
});
