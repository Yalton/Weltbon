
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Bind storage to a temp dir BEFORE any import pulls in the storageBackend singleton.
const UPLOADS_TMP = mkdtempSync(join(tmpdir(), 'weltbon-share-assets-'));
process.env.UPLOADS_DIR = UPLOADS_TMP;

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';
import { assets, entries, shareTokens, universes } from '../src/db/schema.js';
import { issueAccessToken } from '../src/services/auth.js';

// ─── helpers ───────────────────────────────────────────────────────────────

async function makePng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: 100, g: 150, b: 200, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('D-13 share asset boundary (T-38-30 / T-38-31 / T-38-32)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  // Per-beforeEach state.
  let universeId: string;
  let userId: string;
  let shareTokenPlaintext: string;
  let assetId: string;
  let privateAssetId: string;

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

    // 1. Create user + universe.
    const user = await createTestUser(handle, {
      email: `share-asset-${Date.now()}@test.local`,
      password: 'longenoughpw12',
      displayName: 'Asset Share Tester',
    });
    userId = user.id;

    const [univ] = await handle.db
      .insert(universes)
      .values({ userId: user.id, name: 'Share Asset Test Universe' })
      .returning();
    universeId = univ!.id;

    // 2. Mint a share token for the universe.
    const { generateShareToken } = await import('../src/services/share-token.js');
    const seed = generateShareToken();
    shareTokenPlaintext = seed.plaintext;
    await handle.db.insert(shareTokens).values({
      userId: user.id,
      universeId: univ!.id,
      label: 'share-assets-test',
      hash: seed.hash,
      bodySuffix: seed.bodySuffix,
    });

    // 3. Store a real PNG in the storageBackend and create asset rows.
    const { storageBackend } = await import('../src/services/storage/local.js');
    const pngBytes = await makePng();

    // Public asset: will be referenced by a public entry (cover_image_id path).
    assetId = crypto.randomUUID();
    await storageBackend.put(assetId, pngBytes);
    await storageBackend.put(`${assetId}_thumb`, pngBytes);
    await handle.db.insert(assets).values({
      id: assetId,
      universeId,
      filename: 'public-asset.png',
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: pngBytes.length,
      thumbSizeBytes: pngBytes.length,
    });

    // Private asset: will only be referenced by a private entry.
    privateAssetId = crypto.randomUUID();
    await storageBackend.put(privateAssetId, pngBytes);
    await storageBackend.put(`${privateAssetId}_thumb`, pngBytes);
    await handle.db.insert(assets).values({
      id: privateAssetId,
      universeId,
      filename: 'private-asset.png',
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: pngBytes.length,
      thumbSizeBytes: pngBytes.length,
    });

    // 4. Seed a public entry referencing the public asset (cover_image_id).
    await handle.db.insert(entries).values({
      universeId,
      title: 'Public Entry (cover)',
      entryType: 'note',
      isPublic: true,
      coverImageId: assetId,
    });

    // 5. Seed a private entry referencing the private asset (inline body embed).
    await handle.db.insert(entries).values({
      universeId,
      title: 'Private Entry (inline)',
      entryType: 'note',
      isPublic: false,
      body: `Look: ![pic](asset://${privateAssetId})`,
    });
  });

  // ─── Invariant 1: PUBLIC — valid token, public-referenced asset → 200 ────

  it('returns 200 + image bytes for a public-referenced asset via share token (cover path)', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${assetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('returns 200 for thumb of a public-referenced asset via share token', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${assetId}/thumb`, {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('returns 200 for public-referenced asset via inline body embed path', async () => {
    // Add a public entry that embeds the public asset via asset:// in body.
    const inlineAssetId = crypto.randomUUID();
    const { storageBackend } = await import('../src/services/storage/local.js');
    const pngBytes = await makePng();
    await storageBackend.put(inlineAssetId, pngBytes);
    await storageBackend.put(`${inlineAssetId}_thumb`, pngBytes);
    await handle.db.insert(assets).values({
      id: inlineAssetId,
      universeId,
      filename: 'inline-asset.png',
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: pngBytes.length,
      thumbSizeBytes: pngBytes.length,
    });
    // Public entry with inline embed.
    await handle.db.insert(entries).values({
      universeId,
      title: 'Public Entry (inline)',
      entryType: 'note',
      isPublic: true,
      body: `Look: ![pic](asset://${inlineAssetId})`,
    });

    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${inlineAssetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  // ─── Invariant 2: PRIVATE — asset only referenced by private entries → 404 ─

  it('returns 404 for an asset referenced only by is_public=false entries (no existence leak, T-38-30)', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${privateAssetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    // 404 — no existence leak (T-38-30): visitor cannot distinguish private from missing.
    expect(res.status).toBe(404);
  });

  it('returns 404 for thumb of an asset referenced only by private entries', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${privateAssetId}/thumb`, {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect(res.status).toBe(404);
  });

  // ─── Invariant 3: NO-TOKEN — missing or invalid token → 401/404 ──────────

  it('returns 401/404 for a request with no share-token header', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${assetId}/raw`, {
        method: 'GET',
        // No share-token header — requireShareToken should reject.
      }),
    );
    expect([401, 404]).toContain(res.status);
  });

  it('returns 401/404 for a request with an invalid share-token header', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${assetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': 'totally-invalid-token-value' },
      }),
    );
    expect([401, 404]).toContain(res.status);
  });

  // ─── Invariant 4: NO-MUTATION — share-token only cannot reach mutations ───

  it('POST /api/share/assets returns 404/405 (no mutation route exists under /share/*)', async () => {
    // The share router must have no POST /assets route. A request to POST
    // /api/share/assets should 404 (unmatched route) — not 200/201.
    const res = await app.fetch(
      new Request('http://localhost/api/share/assets', {
        method: 'POST',
        headers: {
          'share-token': shareTokenPlaintext,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect([404, 405]).toContain(res.status);
  });

  it('DELETE /api/share/assets/:id returns 404/405 (no mutation route exists under /share/*)', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${assetId}`, {
        method: 'DELETE',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect([404, 405]).toContain(res.status);
  });

  it('authenticated asset mutation routes reject a share-token-only caller with 401 (T-38-31)', async () => {
    // POST /api/universes/:uid/assets — the auth gate fires before any handler.
    // A share-token-only caller has no bearer token → requireAuth returns 401.
    const res = await app.fetch(
      new Request(`http://localhost/api/universes/${universeId}/assets`, {
        method: 'POST',
        headers: {
          'share-token': shareTokenPlaintext,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('authenticated DELETE asset route rejects a share-token-only caller with 401', async () => {
    const res = await app.fetch(
      new Request(`http://localhost/api/universes/${universeId}/assets/${assetId}`, {
        method: 'DELETE',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect(res.status).toBe(401);
  });

  // ─── Sanity baseline: the seed token is valid on the /api/share surface ──

  it('sanity: GET /api/share/entries returns 200 confirming the seed token is valid', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/share/entries', {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Bare-array contract: public entries list (the public entry seeded in beforeEach).
    expect(Array.isArray(body)).toBe(true);
  });



  it('GET /api/share/assets/:id/raw with valid signed URL (?u&e&s) → 200 (no share-token header)', async () => {
    // Mint a signed URL for the public asset the same way the server does.
    const { signShareAssetUrl } = await import('../src/services/asset-signing.js');
    const qs = signShareAssetUrl(universeId, assetId, 'raw');
    const url = `http://localhost/api/share/assets/${assetId}/raw${qs}`;

    const res = await app.fetch(
      new Request(url, {
        method: 'GET',
        // NO share-token header — this is the <img> tag path
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('GET /api/share/assets/:id/thumb with valid signed URL (?u&e&s) → 200 (no share-token header)', async () => {
    const { signShareAssetUrl } = await import('../src/services/asset-signing.js');
    const qs = signShareAssetUrl(universeId, assetId, 'thumb');
    const url = `http://localhost/api/share/assets/${assetId}/thumb${qs}`;

    const res = await app.fetch(
      new Request(url, { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('GET /api/share/assets/:id/raw with tampered signed URL → 401 (no share-token header)', async () => {
    const { signShareAssetUrl } = await import('../src/services/asset-signing.js');
    const qs = signShareAssetUrl(universeId, assetId, 'raw');
    // Tamper the signature.
    const tamperedQs = qs.replace(/s=[^&]+/, 's=0000000000000000000000000000000000000000000000000000000000000000');
    const url = `http://localhost/api/share/assets/${assetId}/raw${tamperedQs}`;

    const res = await app.fetch(
      new Request(url, { method: 'GET' }),
    );
    expect(res.status).toBe(401);
  });

  it('signed share URL for private asset → 404 (is_public gate enforced even with valid sig)', async () => {
    // Even a valid signature cannot bypass the is_public check (T-38-30).
    const { signShareAssetUrl } = await import('../src/services/asset-signing.js');
    const qs = signShareAssetUrl(universeId, privateAssetId, 'raw');
    const url = `http://localhost/api/share/assets/${privateAssetId}/raw${qs}`;

    const res = await app.fetch(
      new Request(url, { method: 'GET' }),
    );
    // Must be 404 (not 200) — signature does not grant access to private assets.
    expect(res.status).toBe(404);
  });

  // ─── Universe backdrop exception (theming spec §3) ────────────────────────
  //
  // The owner opting an asset in as the shared universe's backdrop is a third
  // authorization channel in getPublicAsset (after public-entry reference and
  // map image). These tests use `privateAssetId` — an asset referenced ONLY by
  // a private entry and used by no map — so a 200 can come only from the
  // backdrop channel.

  it('backdrop channel: theme.backdropAssetId authorizes an otherwise-private asset → 200', async () => {
    // No public entry references privateAssetId and no map uses it (see
    // beforeEach). Opt it in as the universe backdrop directly via DB.
    await handle.db
      .update(universes)
      .set({ theme: { backdropAssetId: privateAssetId } })
      .where(eq(universes.id, universeId));

    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${privateAssetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('backdrop channel baseline: same asset with theme=null → 404 (channel is opt-in only)', async () => {
    // Explicit control for the test above: without the backdrop opt-in the
    // asset stays private (theme is null from the beforeEach seed).
    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${privateAssetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('backdrop channel backstop: foreign-universe asset id in theme.backdropAssetId → still 404 (T-38-32)', async () => {
    // Seed a SECOND universe with its own asset, then write that foreign
    // asset id into the FIRST universe's theme directly via DB — bypassing
    // the PATCH-time ownership validation in routes/universes.ts. The
    // assets.universeId scope check in getPublicAsset (Step 1) must backstop:
    // the share seam may never serve another tenant's bytes.
    const { storageBackend } = await import('../src/services/storage/local.js');
    const pngBytes = await makePng();
    const foreignAssetId = crypto.randomUUID();

    const [foreignUniv] = await handle.db
      .insert(universes)
      .values({ userId, name: 'Foreign Universe' })
      .returning();
    await storageBackend.put(foreignAssetId, pngBytes);
    await storageBackend.put(`${foreignAssetId}_thumb`, pngBytes);
    await handle.db.insert(assets).values({
      id: foreignAssetId,
      universeId: foreignUniv!.id,
      filename: 'foreign-asset.png',
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: pngBytes.length,
      thumbSizeBytes: pngBytes.length,
    });

    await handle.db
      .update(universes)
      .set({ theme: { backdropAssetId: foreignAssetId } })
      .where(eq(universes.id, universeId));

    const res = await app.fetch(
      new Request(`http://localhost/api/share/assets/${foreignAssetId}/raw`, {
        method: 'GET',
        headers: { 'share-token': shareTokenPlaintext },
      }),
    );
    // 404 — the asset belongs to a different universe; the backdrop opt-in
    // cannot widen the tenant scope (no existence leak either, T-38-30).
    expect(res.status).toBe(404);
  });
});
