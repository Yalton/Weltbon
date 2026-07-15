/**
 * Phase 12-01 — POST /api/universes/:uid/ingest/commit endpoint tests.
 *
 * The atomic-commit endpoint that takes a reviewed IngestPreview body (with
 * per-entry decisions and edits) and inserts the entire accepted batch
 * (entries + resolved links + new categories) inside ONE Postgres transaction
 * (D-24 atomicity).
 *
 * Coverage (per plan behavior table):
 *   - T-AUTH-01..04 — auth gating (401 missing/invalid; 403 cross-tenant; 404 missing)
 *   - T-HAPPY-01    — 3 accepted entries + 1 in-batch wikilink + 1 new category → 200
 *   - T-HAPPY-02    — collision → user picked rename → new title honored
 *   - T-HAPPY-03    — collision → user picked skip → collider not inserted, others land
 *   - T-HAPPY-04    — silent merge: case-insensitive newName matches existing category
 *   - T-ATOM-01     — failure mid-commit → ZERO new rows in entries/links/categories
 *   - T-PAT-01      — PAT bearer parity with JWT bearer
 *   - T-VALID-01    — Zod 400 on missing entries field
 *   - T-VALID-02    — entry.entryType not in universe.entryTypes → 400 (D-26)
 *   - T-VALID-03    — entry.path = "../escape.md" → 400 (T-11-05 inherited)
 *   - T-VALID-04    — all entries decision=skip → 400 commit_empty (D-29)
 *   - T-COLLIDE-01  — two accepted entries with same final title → 409
 *   - T-SIZE-01     — body has > CHUNK_SIZE * MAX_CHUNKS_PER_TABLE entries → 413 commit_size
 *   - T-OPENAPI-01  — /universes/{uid}/ingest/commit present with bearerAuth + 200/400/401/403/404/409/413/500
 *
 * Skip pattern: tests skip if DATABASE_URL is unreachable (matches the project-wide
 * pattern; the suite registers and skips cleanly when no DB is available).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  type TestDbHandle,
} from './helpers.js';
import { universes, entries, links, categories } from '../src/db/schema.js';
import { CHUNK_SIZE, MAX_CHUNKS_PER_TABLE } from '../src/services/ingest-commit.js';

// ─── Test scaffolding ──────────────────────────────────────────────────────

describe('POST /api/universes/:uid/ingest/commit (Phase 12-01)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);
    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async function createUserAndJwt(email = 'commit@test.com') {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const jwt = await issueAccessToken(user.id);
    return { userId: user.id, jwt };
  }

  async function createUniverse(
    userId: string,
    name = 'Commit World',
    entryTypes: string[] = ['concept', 'character', 'location'],
  ) {
    const [u] = await handle.db
      .insert(universes)
      .values({ userId, name, description: '', entryTypes })
      .returning({ id: universes.id, entryTypes: universes.entryTypes });
    return u;
  }

  async function commitRequest(
    uid: string,
    body: object,
    auth: string | undefined,
  ) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = auth;
    const req = new Request(
      `http://localhost/api/universes/${uid}/ingest/commit`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
    );
    const res = await app.fetch(req);
    let json: unknown = null;
    try {
      const text = await res.text();
      if (text) json = JSON.parse(text);
    } catch {
      // non-JSON
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any };
  }

  // Builds a minimal valid CommitEntry, applying overrides on top of defaults.
  type CategoryRef =
    | { existingId: string }
    | { newName: string }
    | null;
  type Decision =
    | { disposition: 'accept' }
    | { disposition: 'rename'; newTitle: string }
    | { disposition: 'skip' };

  function makeEntry(over: Partial<{
    filename: string;
    path: string;
    title: string;
    entryType: string;
    tags: string[];
    category: CategoryRef;
    body: string;
    meta: Record<string, unknown>;
    linksOut: Array<{
      target: string;
      target_path?: string;
      target_id?: string;
      label: string;
      resolved: boolean;
    }>;
    decision: Decision;
  }> = {}) {
    const title = over.title ?? 'Untitled';
    const path = over.path ?? `entries/${title}.md`;
    return {
      filename: over.filename ?? path.split('/').pop()!,
      path,
      title,
      entryType: over.entryType ?? 'concept',
      tags: over.tags ?? [],
      category: over.category === undefined ? null : over.category,
      body: over.body ?? '',
      meta: over.meta ?? {},
      linksOut: over.linksOut ?? [],
      decision: over.decision ?? { disposition: 'accept' as const },
    };
  }

  function makeBody(
    entriesArr: ReturnType<typeof makeEntry>[],
  ): { entries: ReturnType<typeof makeEntry>[] } {
    return { entries: entriesArr };
  }

  async function rowCounts(universeId: string) {
    const [eRow] = await handle.db
      .select({ c: sql<number>`count(*)` })
      .from(entries)
      .where(eq(entries.universeId, universeId));
    const [lRow] = await handle.db
      .select({ c: sql<number>`count(*)` })
      .from(links)
      .where(eq(links.universeId, universeId));
    const [cRow] = await handle.db
      .select({ c: sql<number>`count(*)` })
      .from(categories)
      .where(eq(categories.universeId, universeId));
    return {
      entries: Number(eRow.c),
      links: Number(lRow.c),
      categories: Number(cRow.c),
    };
  }

  // ─── Auth gating (T-AUTH-01..04) ─────────────────────────────────────────

  it('T-AUTH-01: returns 401 when Authorization header is missing', async () => {
    const { userId } = await createUserAndJwt('auth-missing@commit.test');
    const u = await createUniverse(userId);
    const body = makeBody([makeEntry({ title: 'A' })]);
    const res = await commitRequest(u.id, body, undefined);
    expect(res.status).toBe(401);
  });

  it('T-AUTH-02: returns 401 when bearer token is invalid', async () => {
    const { userId } = await createUserAndJwt('auth-invalid@commit.test');
    const u = await createUniverse(userId);
    const body = makeBody([makeEntry({ title: 'A' })]);
    const res = await commitRequest(u.id, body, 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('T-AUTH-03: returns 403 cross-tenant (user A on user B universe)', async () => {
    const { jwt: jwtA } = await createUserAndJwt('user-a@commit.test');
    const { userId: userBId } = await createUserAndJwt('user-b@commit.test');
    const universeB = await createUniverse(userBId);
    const body = makeBody([makeEntry({ title: 'A' })]);
    const res = await commitRequest(universeB.id, body, `Bearer ${jwtA}`);
    expect(res.status).toBe(403);
  });

  it('T-AUTH-04: returns 404 when universe does not exist', async () => {
    const { jwt } = await createUserAndJwt('missing-uni@commit.test');
    const body = makeBody([makeEntry({ title: 'A' })]);
    const fakeUid = '00000000-0000-0000-0000-000000000000';
    const res = await commitRequest(fakeUid, body, `Bearer ${jwt}`);
    expect(res.status).toBe(404);
  });

  // ─── Happy paths (T-HAPPY-01..04) ────────────────────────────────────────

  it('T-HAPPY-01: 3 accepted entries + 1 in-batch wikilink + 1 new category → 200 with proper response shape and DB rows', async () => {
    const { userId, jwt } = await createUserAndJwt('happy-01@commit.test');
    const u = await createUniverse(userId);

    const body = makeBody([
      makeEntry({
        title: 'Alpha',
        path: 'entries/Alpha.md',
        entryType: 'concept',
        category: { newName: 'Concepts' },
        linksOut: [
          {
            target: 'Beta',
            target_path: 'entries/Beta.md',
            label: 'Beta',
            resolved: true,
          },
        ],
      }),
      makeEntry({
        title: 'Beta',
        path: 'entries/Beta.md',
        entryType: 'concept',
        category: { newName: 'Concepts' },
      }),
      makeEntry({
        title: 'Gamma',
        path: 'entries/Gamma.md',
        entryType: 'concept',
        category: { newName: 'Concepts' },
      }),
    ]);

    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      linksCreated: 1,
      categoriesCreated: 1,
    });
    expect(Array.isArray(res.body.entryIds)).toBe(true);
    expect(res.body.entryIds).toHaveLength(3);

    const after = await rowCounts(u.id);
    expect(after.entries).toBe(3);
    expect(after.links).toBe(1);
    expect(after.categories).toBe(1);
  });

  it('T-HAPPY-02: rename disposition uses newTitle; existing colliding entry untouched', async () => {
    const { userId, jwt } = await createUserAndJwt('happy-02@commit.test');
    const u = await createUniverse(userId);

    // Pre-insert an existing entry that the new batch will collide with.
    const [existing] = await handle.db
      .insert(entries)
      .values({
        universeId: u.id,
        title: 'Foo',
        entryType: 'concept',
      })
      .returning({ id: entries.id });

    const body = makeBody([
      makeEntry({
        title: 'Foo',
        path: 'entries/Foo.md',
        entryType: 'concept',
        decision: { disposition: 'rename', newTitle: 'Foo (2)' },
      }),
    ]);

    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.entryIds).toHaveLength(1);

    // Verify titles in DB: existing 'Foo' untouched, new 'Foo (2)' inserted.
    const allEntries = await handle.db
      .select({ id: entries.id, title: entries.title })
      .from(entries)
      .where(eq(entries.universeId, u.id));
    expect(allEntries).toHaveLength(2);
    const titles = allEntries.map((e) => e.title).sort();
    expect(titles).toEqual(['Foo', 'Foo (2)']);
    // Existing entry id must be unchanged.
    expect(allEntries.find((e) => e.id === existing.id)?.title).toBe('Foo');
  });

  it('T-HAPPY-03: skip disposition does not insert collider; other accepted entries land', async () => {
    const { userId, jwt } = await createUserAndJwt('happy-03@commit.test');
    const u = await createUniverse(userId);

    // Pre-insert an existing 'Foo' entry to provoke the collision.
    await handle.db
      .insert(entries)
      .values({
        universeId: u.id,
        title: 'Foo',
        entryType: 'concept',
      });

    const body = makeBody([
      makeEntry({
        title: 'Foo',
        path: 'entries/Foo.md',
        entryType: 'concept',
        decision: { disposition: 'skip' },
      }),
      makeEntry({
        title: 'Bar',
        path: 'entries/Bar.md',
        entryType: 'concept',
      }),
    ]);

    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.entryIds).toHaveLength(1);

    const after = await rowCounts(u.id);
    // Existing 'Foo' (1) + newly inserted 'Bar' (1) = 2 total.
    expect(after.entries).toBe(2);

    const titles = (
      await handle.db
        .select({ title: entries.title })
        .from(entries)
        .where(eq(entries.universeId, u.id))
    )
      .map((e) => e.title)
      .sort();
    expect(titles).toEqual(['Bar', 'Foo']);
  });

  it('T-HAPPY-04: silent merge — case-insensitive existing category match, no new category created', async () => {
    const { userId, jwt } = await createUserAndJwt('happy-04@commit.test');
    const u = await createUniverse(userId);

    // Pre-insert an existing category 'heroes'.
    const [existingCat] = await handle.db
      .insert(categories)
      .values({ universeId: u.id, label: 'heroes' })
      .returning({ id: categories.id });

    const body = makeBody([
      makeEntry({
        title: 'Aragorn',
        path: 'entries/Aragorn.md',
        entryType: 'character',
        category: { newName: 'Heroes' }, // different case
      }),
    ]);

    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.categoriesCreated).toBe(0);

    // Inserted entry's categoryId must match the existing category id.
    const [inserted] = await handle.db
      .select({ categoryId: entries.categoryId })
      .from(entries)
      .where(eq(entries.universeId, u.id));
    expect(inserted.categoryId).toBe(existingCat.id);

    const after = await rowCounts(u.id);
    expect(after.categories).toBe(1);
  });

  // ─── Atomicity (T-ATOM-01) ───────────────────────────────────────────────

  it('T-ATOM-01: failure mid-commit → zero new rows (ING-05 atomicity acceptance)', async () => {
    const { userId, jwt } = await createUserAndJwt('atom-01@commit.test');
    const u = await createUniverse(userId);

    const before = await rowCounts(u.id);

    // A bad batch: the second entry has a category.existingId that does not exist.
    // The commit service must throw inside the transaction and roll EVERYTHING back.
    const body = makeBody([
      makeEntry({ title: 'Alpha', path: 'entries/Alpha.md', entryType: 'concept' }),
      makeEntry({
        title: 'Beta',
        path: 'entries/Beta.md',
        entryType: 'concept',
        category: { existingId: '00000000-0000-0000-0000-000000000000' },
      }),
      makeEntry({ title: 'Gamma', path: 'entries/Gamma.md', entryType: 'concept' }),
    ]);

    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await rowCounts(u.id);
    expect(after.entries).toBe(before.entries);
    expect(after.links).toBe(before.links);
    expect(after.categories).toBe(before.categories);
  });

  // ─── PAT parity (T-PAT-01) ───────────────────────────────────────────────

  it('T-PAT-01: PAT bearer parity — same 200 + shape as JWT', async () => {
    const { jwt } = await createUserAndJwt('pat-01@commit.test');

    // Create universe via JWT.
    const uRes = await app.fetch(
      new Request('http://localhost/api/universes', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'PAT Commit World' }),
      }),
    );
    expect(uRes.status).toBe(201);
    const uJson = (await uRes.json()) as { id: string };
    const uid = uJson.id;

    // Mint PAT.
    const mintRes = await app.fetch(
      new Request('http://localhost/api/auth/tokens', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'pat-commit' }),
      }),
    );
    const mintJson = (await mintRes.json()) as { plaintext: string };
    const pat = mintJson.plaintext;
    expect(pat).toMatch(/^wbn_pat_/);

    const body = makeBody([
      makeEntry({ title: 'Solo', path: 'entries/Solo.md', entryType: 'concept' }),
    ]);
    const res = await commitRequest(uid, body, `Bearer ${pat}`);
    expect(res.status).toBe(200);
    expect(res.body.entryIds).toHaveLength(1);
    expect(res.body.linksCreated).toBe(0);
    expect(res.body.categoriesCreated).toBe(0);
  });

  // ─── Validation (T-VALID-01..04) ─────────────────────────────────────────

  it('T-VALID-01: returns 400 when body is missing the entries field (Zod)', async () => {
    const { userId, jwt } = await createUserAndJwt('valid-01@commit.test');
    const u = await createUniverse(userId);
    const res = await commitRequest(u.id, {}, `Bearer ${jwt}`);
    expect(res.status).toBe(400);
  });

  it('T-VALID-02: returns 400 when entry.entryType is not in universe.entryTypes (D-26)', async () => {
    const { userId, jwt } = await createUserAndJwt('valid-02@commit.test');
    const u = await createUniverse(userId, 'Constrained World', [
      'concept',
      'character',
    ]);
    const body = makeBody([
      makeEntry({
        title: 'Bad',
        path: 'entries/Bad.md',
        entryType: 'invalidtype',
      }),
    ]);
    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBe(400);
  });

  it('T-VALID-03: returns 400 when entry.path is a traversal (T-11-05 inherited)', async () => {
    const { userId, jwt } = await createUserAndJwt('valid-03@commit.test');
    const u = await createUniverse(userId);
    const body = makeBody([
      makeEntry({
        title: 'Escape',
        path: '../escape.md',
        entryType: 'concept',
      }),
    ]);
    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/[Ii]nvalid path/);
  });

  it('T-VALID-04: returns 400 when all entries are skipped (commit_empty / D-29)', async () => {
    const { userId, jwt } = await createUserAndJwt('valid-04@commit.test');
    const u = await createUniverse(userId);
    const body = makeBody([
      makeEntry({
        title: 'A',
        path: 'entries/A.md',
        entryType: 'concept',
        decision: { disposition: 'skip' },
      }),
      makeEntry({
        title: 'B',
        path: 'entries/B.md',
        entryType: 'concept',
        decision: { disposition: 'skip' },
      }),
    ]);
    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/(accepted|commit_empty|empty|No entries)/i);
  });

  // ─── Post-edit collision (T-COLLIDE-01) ──────────────────────────────────

  it('T-COLLIDE-01: two accepted entries with same final title → 409', async () => {
    const { userId, jwt } = await createUserAndJwt('collide-01@commit.test');
    const u = await createUniverse(userId);

    // User typo'd both renames to the same value.
    const body = makeBody([
      makeEntry({
        title: 'Original A',
        path: 'entries/A.md',
        entryType: 'concept',
        decision: { disposition: 'rename', newTitle: 'Same Title' },
      }),
      makeEntry({
        title: 'Original B',
        path: 'entries/B.md',
        entryType: 'concept',
        decision: { disposition: 'rename', newTitle: 'Same Title' },
      }),
    ]);
    const res = await commitRequest(u.id, body, `Bearer ${jwt}`);
    expect(res.status).toBe(409);
  });

  // ─── Size cap (T-SIZE-01) ────────────────────────────────────────────────

  it('T-SIZE-01: returns 413 with commit_size when batch exceeds cap', async () => {
    const { userId, jwt } = await createUserAndJwt('size-01@commit.test');
    const u = await createUniverse(userId);

    // The cap is on ROWS, not entries:
    //   cap            = CHUNK_SIZE * MAX_CHUNKS_PER_TABLE * 3   (= 150_000)
    //   totalRowsBound = accepted.length          (entries table)
    //                  + accepted.length          (categories upper bound)
    //                  + acceptedLinkCount        (links table; 0 here)
    // so each link-free entry contributes TWO rows. The original fixture used
    // N = 50_001 on the assumption that the cap was 50_000 ENTRIES; that only
    // bounds to 100_002 rows, comfortably UNDER the 150_000-row cap, so the
    // service correctly returned 200 and the test read it as a missing cap.
    // Derive N from the exported constants so this can never drift again.
    //
    // Body is tiny per row so JSON encode is not the bottleneck. Each entry has
    // a unique title and path to dodge the in-batch collision pre-check.
    const cap = CHUNK_SIZE * MAX_CHUNKS_PER_TABLE * 3;
    const N = Math.floor(cap / 2) + 1; // 2 rows per link-free entry -> 2N > cap
    const ents: ReturnType<typeof makeEntry>[] = [];
    for (let i = 0; i < N; i++) {
      ents.push(
        makeEntry({
          title: `T${i}`,
          path: `entries/T${i}.md`,
          entryType: 'concept',
        }),
      );
    }
    const res = await commitRequest(u.id, makeBody(ents), `Bearer ${jwt}`);
    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/commit_size/);
  });

  // T-SIZE-02: the raw-body bodyLimit rejects an oversize body via Content-Length
  // BEFORE it is buffered/parsed into memory — the real pre-parse OOM guard the
  // commit_size row cap (which runs post-parse) is not. Shrink
  // INGEST_MAX_BODY_BYTES so we don't allocate 150 MB; send an explicit
  // Content-Length (as a real HTTP client does) so bodyLimit takes its early
  // 413 path rather than the streaming path.
  it('T-SIZE-02: returns 413 when the raw body exceeds INGEST_MAX_BODY_BYTES (pre-parse)', async () => {
    const { userId, jwt } = await createUserAndJwt('size-02@commit.test');
    const u = await createUniverse(userId);

    const original = process.env.INGEST_MAX_BODY_BYTES;
    process.env.INGEST_MAX_BODY_BYTES = '100'; // 100 bytes — any real commit body exceeds it
    try {
      // Body content is irrelevant: bodyLimit rejects on Content-Length before
      // the handler ever parses it.
      const bodyStr = JSON.stringify(
        makeBody([makeEntry({ title: 'Big', path: 'entries/Big.md', entryType: 'concept' })]),
      );
      expect(bodyStr.length).toBeGreaterThan(100);
      const req = new Request(`http://localhost/api/universes/${u.id}/ingest/commit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(bodyStr.length),
          Authorization: `Bearer ${jwt}`,
        },
        body: bodyStr,
      });
      const res = await app.fetch(req);
      expect(res.status).toBe(413);
      expect(String((await res.json()).error)).toMatch(/too large/i);
    } finally {
      if (original === undefined) delete process.env.INGEST_MAX_BODY_BYTES;
      else process.env.INGEST_MAX_BODY_BYTES = original;
    }
  });

  // ─── OpenAPI doc presence (T-OPENAPI-01) ────────────────────────────────

  it('T-OPENAPI-01: GET /api/openapi.json includes /universes/{uid}/ingest/commit with bearerAuth and full response set', async () => {
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<
        string,
        {
          post?: {
            security?: Array<Record<string, unknown>>;
            responses?: Record<string, unknown>;
          };
        }
      >;
    };
    const commitPath = doc.paths['/universes/{uid}/ingest/commit'];
    expect(commitPath).toBeTruthy();
    expect(commitPath.post).toBeTruthy();
    expect(commitPath.post!.security).toEqual(
      expect.arrayContaining([expect.objectContaining({ bearerAuth: [] })]),
    );
    const responseKeys = Object.keys(commitPath.post!.responses ?? {});
    for (const code of ['200', '400', '401', '403', '404', '409', '413', '500']) {
      expect(responseKeys).toContain(code);
    }
  });
});
