/**
 * Universe adoption (spec 2026-08-08, A-01..A-12).
 *
 * Two INSTANCES: A is the adopter (think: a fresh desktop install), B is the
 * remote that already holds the universe. Same harness shape as
 * tests/sync-run.test.ts — B is a Hono app object, not a socket, so the peer
 * transport is injected (D-05, A-04b).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// CRITICAL — must be set BEFORE the *first* env() call in the process, and MUST
// be the exact literal '0'.repeat(64) shared by every other DB-gated file. The
// integration lane runs them all in one process (singleFork), so whichever
// file's env() wins the race sets the key for the rest. See
// tests/sync-client-crud.test.ts for the full story.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { adoptUniverse, listRemoteUniverses } from '../src/services/sync/adopt.js';
import {
  SyncLinkNotFoundError,
  SyncUniverseAlreadyLocalError,
  SyncUniverseNotOnRemoteError,
} from '../src/services/sync/run-errors.js';
import { runSync } from '../src/services/sync/run-sync.js';
import { storageBackend } from '../src/services/storage/local.js';

// Used by Task 7's acceptance test. If the typecheck flags it as unused while
// only Tasks 5-6 exist, add it in Task 7 instead of deleting the import above.
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('universe adoption', () => {
  let A: TestDbHandle;
  let B: TestDbHandle;
  let uploadsA: string;
  let uploadsB: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let ownerA: { id: string; email: string };
  let ownerB: { id: string; email: string };
  let universeId: string;   // exists on B only
  let remoteId: string;     // A's row pointing at B

  beforeAll(async () => {
    uploadsA = await mkdtemp(join(tmpdir(), 'weltbon-adopt-a-'));
    uploadsB = await mkdtemp(join(tmpdir(), 'weltbon-adopt-b-'));
    A = await createTestDb();
    B = await createTestDb();
    // Two INSTANCES demands two distinct databases; without this check every
    // assertion below could pass vacuously (sync-convergence.test.ts precedent).
    if (process.env.WELTBON_TEST_DRIVER !== 'pglite') {
      expect(A.schemaName).not.toBe(B.schemaName);
    }
    expect(A.db).not.toBe(B.db);
    app = (await import('../src/index.js')).createApp();
  });

  afterAll(async () => {
    await A.cleanup();
    await B.cleanup();
  });

  async function use(which: 'A' | 'B'): Promise<void> {
    const { setTestDb } = await import('../src/db/client.js');
    const handle = which === 'A' ? A : B;
    setTestDb(handle.db as any, handle.pool);
    process.env.UPLOADS_DIR = which === 'A' ? uploadsA : uploadsB;
  }

  function makeFetch() {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      const path = u.pathname + u.search;
      await use('B');
      try {
        return await app.request(path, init);
      } finally {
        await use('A');
      }
    };
  }

  async function mintPat(handle: TestDbHandle, userId: string): Promise<string> {
    const { generatePatToken } = await import('../src/services/pat.js');
    const { personalAccessTokens } = await import('../src/db/schema.js');
    const { plaintext, hash, bodySuffix } = generatePatToken();
    await handle.db.insert(personalAccessTokens).values({ userId, label: 'peer', hash, bodySuffix });
    return plaintext;
  }

  beforeEach(async () => {
    await cleanDb(A);
    await cleanDb(B);

    ownerA = await createTestUser(A, { email: 'a@test.dev', password: 'password123' });
    ownerB = await createTestUser(B, { email: 'b@test.dev', password: 'password123' });

    // The universe lives ONLY on B — this is the whole premise of adoption.
    const { universes, syncRemotes } = await import('../src/db/schema.js');
    const [u] = await B.db
      .insert(universes)
      .values({ userId: ownerB.id, name: 'Aethel', description: 'from the remote' })
      .returning();
    universeId = u.id;

    const pat = await mintPat(B, ownerB.id);
    const { encryptSecret } = await import('../src/services/crypto.js');
    const [remote] = await A.db
      .insert(syncRemotes)
      .values({
        userId: ownerA.id,
        label: 'prod',
        // Never dialed — makeFetch intercepts every request.
        baseUrl: 'https://peer.example',
        encryptedPat: encryptSecret(pat, '0'.repeat(64)),
      })
      .returning();
    remoteId = remote.id;

    await use('A');
  });

  describe('listRemoteUniverses (A-04)', () => {
    it('lists what the remote holds, marked absent when we do not have it', async () => {
      const rows = await listRemoteUniverses(remoteId, ownerA.id, makeFetch());
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(universeId);
      expect(rows[0].name).toBe('Aethel');
      expect(rows[0].localState).toBe('absent');
    });

    it('marks a universe we already hold as present, and as linked once linked', async () => {
      const { universes, syncLinks } = await import('../src/db/schema.js');
      await A.db.insert(universes).values({ id: universeId, userId: ownerA.id, name: 'local copy' });

      let rows = await listRemoteUniverses(remoteId, ownerA.id, makeFetch());
      expect(rows[0].localState).toBe('present');

      await A.db.insert(syncLinks).values({ universeId, remoteId });
      rows = await listRemoteUniverses(remoteId, ownerA.id, makeFetch());
      expect(rows[0].localState).toBe('linked');
    });

    it('refuses another user\'s remote as not-found, never as forbidden', async () => {
      const stranger = await createTestUser(A, { email: 'stranger@test.dev', password: 'password123' });
      await expect(listRemoteUniverses(remoteId, stranger.id, makeFetch())).rejects.toBeInstanceOf(
        SyncLinkNotFoundError,
      );
    });

    it('does not mark a universe held by a DIFFERENT local user as present', async () => {
      // localState answers "can this caller act on it", not "does the row
      // exist". A stranger's universe must read `absent` so the caller is
      // offered Adopt — and then gets the engine's 403 (A-07), rather than
      // being told an unrelated row exists.
      const { universes } = await import('../src/db/schema.js');
      const stranger = await createTestUser(A, { email: 'other@test.dev', password: 'password123' });
      await A.db.insert(universes).values({ id: universeId, userId: stranger.id, name: 'theirs' });

      const rows = await listRemoteUniverses(remoteId, ownerA.id, makeFetch());
      expect(rows[0].localState).toBe('absent');
    });

    it('is reachable over the JWT route and refuses a PAT (D-10)', async () => {
      const { issueAccessToken } = await import('../src/services/auth.js');
      const jwt = await issueAccessToken(ownerA.id);

      // The route builds its own client with the real global fetch, so point
      // the stored baseUrl at the in-process peer by intercepting fetch itself.
      const peer = makeFetch();
      const original = globalThis.fetch;
      globalThis.fetch = peer as unknown as typeof globalThis.fetch;
      try {
        await use('A');
        const res = await app.request(`/api/sync/remotes/${remoteId}/universes`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.universes[0].id).toBe(universeId);
        expect(body.universes[0].localState).toBe('absent');
      } finally {
        globalThis.fetch = original;
      }

      const patPlaintext = await mintPat(A, ownerA.id);
      await use('A');
      const patRes = await app.request(`/api/sync/remotes/${remoteId}/universes`, {
        headers: { Authorization: `Bearer ${patPlaintext}` },
      });
      expect(patRes.status).toBe(401);
    });
  });

  describe('adoptUniverse (A-02, A-07, A-09)', () => {
    it('creates the local universe with the SAME id, owned by the adopter (S-05)', async () => {
      const { link } = await adoptUniverse({
        remoteId, universeId, ownerId: ownerA.id, fetchImpl: makeFetch(),
      });

      const { universes } = await import('../src/db/schema.js');
      const [local] = await A.db.select().from(universes).where(eq(universes.id, universeId));
      expect(local).toBeDefined();
      // The id is the whole point: sync matches rows by shared UUID, which is
      // exactly why import (which remaps ids, S-05) can never substitute.
      expect(local.id).toBe(universeId);
      // C-08: the manifest's user id is never trusted; ownership is the adopter's.
      expect(local.userId).toBe(ownerA.id);
      expect(local.name).toBe('Aethel');
      expect(local.description).toBe('from the remote');
      expect(link.universeId).toBe(universeId);
      expect(link.remoteId).toBe(remoteId);
    });

    it('copies the remote\'s timestamps verbatim, so the first merge sees no universe difference', async () => {
      const { universes } = await import('../src/db/schema.js');
      const [onB] = await B.db.select().from(universes).where(eq(universes.id, universeId));

      await adoptUniverse({ remoteId, universeId, ownerId: ownerA.id, fetchImpl: makeFetch() });

      const [onA] = await A.db.select().from(universes).where(eq(universes.id, universeId));
      expect(onA.updatedAt.toISOString()).toBe(onB.updatedAt.toISOString());
      expect(onA.createdAt.toISOString()).toBe(onB.createdAt.toISOString());
    });

    it('refuses a universe this user already holds, and does NOT clobber it (A-07)', async () => {
      const { universes } = await import('../src/db/schema.js');
      await A.db.insert(universes).values({
        id: universeId, userId: ownerA.id, name: 'my local name', description: 'mine',
      });

      // The row check runs FIRST and unconditionally (not inside `.rejects`),
      // so it executes whether or not the throw happens. `await expect(...).
      // rejects` aborts the test body on the first failed assertion — if the
      // no-clobber check were written only AFTER that line, a guard that
      // failed to throw would hide the clobber it let through: the test would
      // fail on "did not reject" without ever proving whether the row was
      // touched. This ordering is what makes the mutation test (removing the
      // guard) fail on `local.name` — 'my local name' having become 'Aethel'
      // — rather than merely on "no error was thrown".
      const promise = adoptUniverse({ remoteId, universeId, ownerId: ownerA.id, fetchImpl: makeFetch() });
      await promise.catch(() => {});

      const [local] = await A.db.select().from(universes).where(eq(universes.id, universeId));
      expect(local.name).toBe('my local name');
      expect(local.description).toBe('mine');

      await expect(promise).rejects.toBeInstanceOf(SyncUniverseAlreadyLocalError);
    });

    it('refuses an id another local user owns, with the engine\'s own 403 (A-07)', async () => {
      const { universes } = await import('../src/db/schema.js');
      const stranger = await createTestUser(A, { email: 'other@test.dev', password: 'password123' });
      await A.db.insert(universes).values({ id: universeId, userId: stranger.id, name: 'theirs' });

      await expect(
        adoptUniverse({ remoteId, universeId, ownerId: ownerA.id, fetchImpl: makeFetch() }),
      ).rejects.toMatchObject({ status: 403 });

      const [local] = await A.db.select().from(universes).where(eq(universes.id, universeId));
      expect(local.userId).toBe(stranger.id);
      expect(local.name).toBe('theirs');
    });

    it('404s when the remote does not hold that universe', async () => {
      await expect(
        adoptUniverse({
          remoteId,
          universeId: '99999999-9999-4999-8999-999999999999',
          ownerId: ownerA.id,
          fetchImpl: makeFetch(),
        }),
      ).rejects.toBeInstanceOf(SyncUniverseNotOnRemoteError);
    });

    it('refuses another user\'s remote as not-found', async () => {
      const stranger = await createTestUser(A, { email: 'nope@test.dev', password: 'password123' });
      await expect(
        adoptUniverse({ remoteId, universeId, ownerId: stranger.id, fetchImpl: makeFetch() }),
      ).rejects.toBeInstanceOf(SyncLinkNotFoundError);
    });

    it('is recoverable when the link insert fails after the seed (A-09)', async () => {
      // Simulate the crash window: seed the universe, then adopt. The universe
      // now exists and is owned by the caller, so adoption takes the A-07 409
      // path and the remedy is the ordinary link route — which now works,
      // because the FK is satisfiable.
      await adoptUniverse({ remoteId, universeId, ownerId: ownerA.id, fetchImpl: makeFetch() });
      const { syncLinks } = await import('../src/db/schema.js');
      await A.db.delete(syncLinks).where(eq(syncLinks.universeId, universeId));

      await expect(
        adoptUniverse({ remoteId, universeId, ownerId: ownerA.id, fetchImpl: makeFetch() }),
      ).rejects.toBeInstanceOf(SyncUniverseAlreadyLocalError);

      // ...and the ordinary link route succeeds where it 404'd before adoption.
      const { issueAccessToken } = await import('../src/services/auth.js');
      const jwt = await issueAccessToken(ownerA.id);
      await use('A');
      const res = await app.request('/api/sync/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ universeId, remoteId }),
      });
      expect(res.status).toBe(201);
    });

    it('is reachable over the JWT route in the link wire shape, and refuses a PAT (D-10)', async () => {
      // Nothing in this file's other tests issues an HTTP request to
      // POST /adopt — every other adoptUniverse test calls the service
      // directly. This is the one that exercises adoptBodySchema, the actual
      // route handler (and its two error-hierarchy mapping, C-19/C-21), and
      // toLinkWire's 201 shape, which is what Task 8's hook consumes.
      const { issueAccessToken } = await import('../src/services/auth.js');
      const jwt = await issueAccessToken(ownerA.id);

      // The route builds its own client with the real global fetch, so point
      // the stored baseUrl at the in-process peer by intercepting fetch itself
      // — same technique as the D-10 test above.
      const peer = makeFetch();
      const original = globalThis.fetch;
      globalThis.fetch = peer as unknown as typeof globalThis.fetch;
      try {
        await use('A');
        const res = await app.request('/api/sync/adopt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ remoteId, universeId }),
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.universeId).toBe(universeId);
        expect(body.remoteId).toBe(remoteId);
        expect(body.remoteLabel).toBe('prod');
        expect(body.remoteBaseUrl).toBe('https://peer.example');
        expect(body.status).toBe('idle');
        expect(body.id).toBeDefined();

        const { universes } = await import('../src/db/schema.js');
        const [local] = await A.db.select().from(universes).where(eq(universes.id, universeId));
        expect(local.name).toBe('Aethel');
      } finally {
        globalThis.fetch = original;
      }

      const patPlaintext = await mintPat(A, ownerA.id);
      await use('A');
      const patRes = await app.request('/api/sync/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${patPlaintext}` },
        body: JSON.stringify({ remoteId, universeId }),
      });
      expect(patRes.status).toBe(401);
    });
  });

  describe('acceptance: web → desktop, end to end (#24)', () => {
    /**
     * At least 900x700. A smaller source produces a thumbnail byte-identical to
     * the original (`withoutEnlargement: true`), so an assertion about the
     * thumbnail would pass without the resize path ever running — the F0-06
     * fixture lesson.
     */
    async function realPngLarge(seed: number): Promise<Buffer> {
      const sharp = (await import('sharp')).default;
      return sharp({
        create: { width: 900, height: 700, channels: 3, background: { r: seed, g: 10, b: 20 } },
      })
        .png()
        .toBuffer();
    }

    it('adopts a universe with an entry and an image, then converges both ways', async () => {
      const { universes, entries, assets, syncConflicts } = await import('../src/db/schema.js');

      // ── 1. Content on B (think: created in the web app) ──────────────────
      const bytes = await realPngLarge(60);
      await use('B');
      const [entryOnB] = await B.db
        .insert(entries)
        .values({ universeId, title: 'Elandra', entryType: 'character', body: 'a knight' })
        .returning();
      const [assetOnB] = await B.db
        .insert(assets)
        .values({
          universeId,
          filename: 'banner.png',
          mimeType: 'image/png',
          extension: 'png',
          sizeBytes: bytes.length,
          thumbSizeBytes: 1,
          contentHash: sha256(bytes),
        })
        .returning();
      await storageBackend.put(assetOnB.id, bytes);

      // ── 2. Adopt on A (think: the desktop app) ───────────────────────────
      await use('A');
      const { link } = await adoptUniverse({
        remoteId, universeId, ownerId: ownerA.id, fetchImpl: makeFetch(),
      });

      // A-06: adoption does not sync. The universe is here; its contents are not.
      const [seeded] = await A.db.select().from(universes).where(eq(universes.id, universeId));
      expect(seeded.id).toBe(universeId);
      const beforeRun = await A.db.select().from(entries).where(eq(entries.universeId, universeId));
      expect(beforeRun).toHaveLength(0);

      // ── 3. First sync pulls everything ───────────────────────────────────
      await use('A');
      const run = await runSync(link.id, ownerA.id, { fetchImpl: makeFetch() });
      expect(run.appliedLocally.upserted.entries).toBe(1);

      await use('A');
      const [entryOnA] = await A.db.select().from(entries).where(eq(entries.id, entryOnB.id));
      expect(entryOnA.title).toBe('Elandra');

      const [assetOnA] = await A.db.select().from(assets).where(eq(assets.id, assetOnB.id));
      expect(assetOnA).toBeDefined();

      // The BYTES, not just the row — and a real PNG of the right size.
      const bytesOnA = await storageBackend.get(assetOnB.id);
      expect(bytesOnA?.equals(bytes)).toBe(true);
      const sharp = (await import('sharp')).default;
      const meta = await sharp(bytesOnA!).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(900);
      expect(meta.height).toBe(700);
      // The thumbnail was derived locally, and derived SMALLER than the source.
      expect(await storageBackend.exists(`${assetOnB.id}_thumb`)).toBe(true);
      const thumb = await storageBackend.get(`${assetOnB.id}_thumb`);
      expect(thumb!.length).toBeLessThan(bytes.length);

      // ── 4. Edit on both sides; converge; the loser is preserved ──────────
      await use('A');
      await A.db.update(entries).set({ body: 'edited on the desktop', updatedAt: new Date() })
        .where(eq(entries.id, entryOnB.id));
      await use('B');
      await B.db.update(entries).set({ body: 'edited on the web', updatedAt: new Date(Date.now() + 1000) })
        .where(eq(entries.id, entryOnB.id));

      await use('A');
      const run2 = await runSync(link.id, ownerA.id, { fetchImpl: makeFetch() });
      expect(run2.conflicts).toBe(1);

      await use('A');
      const [convergedA] = await A.db.select().from(entries).where(eq(entries.id, entryOnB.id));
      await use('B');
      const [convergedB] = await B.db.select().from(entries).where(eq(entries.id, entryOnB.id));
      expect(convergedA.body).toBe(convergedB.body);
      expect(convergedA.body).toBe('edited on the web'); // later timestamp wins (LWW)

      await use('A');
      const losers = await A.db.select().from(syncConflicts).where(eq(syncConflicts.universeId, universeId));
      expect(losers).toHaveLength(1);
      expect(losers[0].resolvedAt).toBeNull();
      // The loser really is the overwritten text, not an empty placeholder.
      expect((losers[0].loserPayload as any).body).toBe('edited on the desktop');
    });

    it('a failed first sync leaves a state the next run converges (A-10)', async () => {
      const { entries } = await import('../src/db/schema.js');
      await use('B');
      await B.db.insert(entries).values({
        universeId, title: 'Solo', entryType: 'character', body: 'x',
      });

      await use('A');
      const { link } = await adoptUniverse({
        remoteId, universeId, ownerId: ownerA.id, fetchImpl: makeFetch(),
      });

      // Never ran a sync: base is null and the local side holds no collection
      // rows. deriveOps' deletes are `side.keys() \ merged` and merged is the
      // union, so neither side can derive a delete from this state.
      await use('A');
      const run = await runSync(link.id, ownerA.id, { fetchImpl: makeFetch() });
      expect(run.appliedLocally.upserted.entries).toBe(1);
      expect(run.pushed.deleted.entries ?? 0).toBe(0);

      await use('B');
      const stillOnB = await B.db.select().from(entries).where(eq(entries.universeId, universeId));
      expect(stillOnB).toHaveLength(1);
    });
  });
});
