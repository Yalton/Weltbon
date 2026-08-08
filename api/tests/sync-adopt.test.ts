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
import { listRemoteUniverses } from '../src/services/sync/adopt.js';
import { SyncLinkNotFoundError } from '../src/services/sync/run-errors.js';

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
});
