/**
 * Phase 11-03 Task 2 — POST /api/universes/:uid/ingest endpoint tests.
 *
 * Coverage:
 *   - Auth gating (401 missing/invalid bearer; 403 cross-user)
 *   - Happy path: multipart files[] returns IngestPreview JSON
 *   - Happy path: multipart zip returns IngestPreview JSON (filters hidden dirs)
 *   - PAT parity: same 200 with PAT bearer
 *   - No-DB-write: row counts unchanged before/after a 200 response
 *   - 413 file_count cap (>1000 file parts)
 *   - 413 file_size cap (>1 MB single file)
 *   - 413 zip_size cap (>50 MB zip)
 *   - 413 total_uncompressed_size cap (zip-bomb fixture, <2s wall time)
 *   - 400 neither files nor zip
 *   - 400 both files and zip
 *   - 400 zip part with bad magic bytes
 *   - 404 missing universe
 *   - OpenAPI doc presence (/api/openapi.json contains the path with bearerAuth)
 *
 * Skip pattern: tests skip if DATABASE_URL is unreachable (matches the project-wide
 * pattern; non-DB tests in this file would still run but the suite needs createTestDb).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  type TestDbHandle,
} from './helpers.js';
import { universes, entries, links, categories } from '../src/db/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ZIP_DIR = join(__dirname, 'fixtures', 'ingest', 'zip');
const VALID_VAULT_ZIP = join(ZIP_DIR, 'valid-vault.zip');
const ZIP_BOMB_ZIP = join(ZIP_DIR, 'zip-bomb.zip');
const BUILD_SCRIPT = join(ZIP_DIR, 'build-zips.ts');

function ensureFixtures(): void {
  if (existsSync(VALID_VAULT_ZIP) && existsSync(ZIP_BOMB_ZIP)) return;
  const tsxBin = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, [BUILD_SCRIPT], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`build-zips.ts failed (exit ${result.status})`);
  }
}

describe('POST /api/universes/:uid/ingest (Phase 11-03 Task 2)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    ensureFixtures();
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
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

  async function createUserAndJwt(email = 'ingest@test.com') {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const jwt = await issueAccessToken(user.id);
    return { userId: user.id, jwt };
  }

  async function createUniverse(userId: string, name = 'Ingest Test World') {
    const [u] = await handle.db
      .insert(universes)
      .values({ userId, name, description: '' })
      .returning({ id: universes.id, entryTypes: universes.entryTypes });
    return u;
  }

  async function ingestRequest(
    uid: string,
    formData: FormData,
    auth: string | undefined
  ) {
    const headers: Record<string, string> = {};
    if (auth) headers['Authorization'] = auth;
    const req = new Request(`http://localhost/api/universes/${uid}/ingest`, {
      method: 'POST',
      headers,
      body: formData,
    });
    const res = await app.fetch(req);
    let json: unknown = null;
    try {
      const text = await res.text();
      if (text) json = JSON.parse(text);
    } catch {
      // non-JSON body
    }
    return { status: res.status, body: json as any };
  }

  function makeFile(name: string, content: string): File {
    return new File([content], name, { type: 'text/markdown' });
  }

  function makeZipFile(name: string, buf: Buffer): File {
    // FILE_TYPE: application/zip; multipart Content-Type is set by FormData
    return new File([buf], name, { type: 'application/zip' });
  }

  let postPreviewCounter = 0;

  // #37 SP-04: posts a fresh preview request against its own user+universe
  // (each test gets an isolated batch) and returns the raw Response, so
  // callers can `await res.json()` / check `res.status` directly the way the
  // task brief's test cases do. `split_level` is transmitted as a multipart
  // text field: omitted when undefined (auto-detect), the literal string
  // "null" for explicit null (do not split), else the level as a string.
  async function postPreview(opts: {
    files: Array<{ path: string; content: string }>;
    split_level?: number | null;
  }): Promise<Response> {
    const { userId, jwt } = await createUserAndJwt(
      `split-preview-${postPreviewCounter++}@test.com`
    );
    const u = await createUniverse(userId);
    const fd = new FormData();
    for (const f of opts.files) {
      fd.append('files', makeFile(f.path, f.content));
    }
    if (opts.split_level !== undefined) {
      fd.append('split_level', opts.split_level === null ? 'null' : String(opts.split_level));
    }
    const req = new Request(`http://localhost/api/universes/${u.id}/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: fd,
    });
    return app.fetch(req);
  }

  // ─── Auth gating ─────────────────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const { userId } = await createUserAndJwt('auth-missing@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    fd.append('files', makeFile('a.md', '# A'));
    const res = await ingestRequest(u.id, fd, undefined);
    expect(res.status).toBe(401);
  });

  it('returns 401 when bearer token is invalid', async () => {
    const { userId } = await createUserAndJwt('auth-invalid@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    fd.append('files', makeFile('a.md', '# A'));
    const res = await ingestRequest(u.id, fd, 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('returns 403 when user A tries to ingest into user B’s universe (cross-tenant)', async () => {
    const { jwt: jwtA } = await createUserAndJwt('user-a@test.com');
    const { userId: userBId } = await createUserAndJwt('user-b@test.com');
    const universeB = await createUniverse(userBId);
    const fd = new FormData();
    fd.append('files', makeFile('a.md', '# A'));
    const res = await ingestRequest(universeB.id, fd, `Bearer ${jwtA}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when universe does not exist', async () => {
    const { jwt } = await createUserAndJwt('missing-uni@test.com');
    const fd = new FormData();
    fd.append('files', makeFile('a.md', '# A'));
    // Valid-uuid format but no universe with this ID
    const fakeUid = '00000000-0000-0000-0000-000000000000';
    const res = await ingestRequest(fakeUid, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(404);
  });

  // ─── Happy paths (200) ────────────────────────────────────────────────────

  it('200: multipart files[] returns IngestPreview with parsed entries', async () => {
    const { userId, jwt } = await createUserAndJwt('happy-files@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    fd.append('files', makeFile('alpha.md', '# Alpha\n\nHello [[Beta]].'));
    fd.append('files', makeFile('beta.md', '# Beta\n\nWorld.'));
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.markdown_files_parsed).toBe(2);
    expect(res.body.entries).toHaveLength(2);
    const titles = res.body.entries.map((e: { title: string }) => e.title).sort();
    expect(titles).toEqual(['Alpha', 'Beta']);
    // Wikilink Alpha→Beta resolves in-batch.
    const alpha = res.body.entries.find((e: { title: string }) => e.title === 'Alpha');
    expect(alpha.linksOut).toHaveLength(1);
    expect(alpha.linksOut[0].resolved).toBe(true);
  });

  it('200: multipart zip returns IngestPreview; hidden dirs filtered before parseBatch', async () => {
    const { userId, jwt } = await createUserAndJwt('happy-zip@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    fd.append('zip', makeZipFile('vault.zip', readFileSync(VALID_VAULT_ZIP)));
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    // vault-basic has 12 .md files; .obsidian/ + .trash/ entries are hidden.
    expect(res.body.summary.markdown_files_parsed).toBeGreaterThan(0);
    expect(res.body.summary.hidden_paths_filtered).toBeGreaterThan(0);
    // entries[] should not include any hidden-path file.
    expect(
      res.body.entries.every((e: { path: string }) => !e.path.split('/').some((s: string) => s.startsWith('.')))
    ).toBe(true);
  });

  it('PAT parity: same 200 IngestPreview with PAT bearer as with JWT bearer', async () => {
    const { jwt } = await createUserAndJwt('pat-parity@test.com');
    // Create universe via JWT
    const uRes = await app.fetch(
      new Request('http://localhost/api/universes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Parity Universe' }),
      })
    );
    expect(uRes.status).toBe(201);
    const uJson = (await uRes.json()) as { id: string };
    const uid = uJson.id;

    // Mint PAT
    const mintRes = await app.fetch(
      new Request('http://localhost/api/auth/tokens', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'pat-ingest' }),
      })
    );
    const mintJson = (await mintRes.json()) as { plaintext: string };
    const pat = mintJson.plaintext;
    expect(pat).toMatch(/^wbn_pat_/);

    const fd = new FormData();
    fd.append('files', makeFile('only.md', '# Only'));
    const res = await ingestRequest(uid, fd, `Bearer ${pat}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.markdown_files_parsed).toBe(1);
  });

  it('no DB writes: entries/links/categories row counts unchanged after a 200 ingest', async () => {
    const { userId, jwt } = await createUserAndJwt('no-write@test.com');
    const u = await createUniverse(userId);

    const before = {
      entries: Number((await handle.db.select({ c: sql<number>`count(*)` }).from(entries))[0].c),
      links: Number((await handle.db.select({ c: sql<number>`count(*)` }).from(links))[0].c),
      categories: Number(
        (await handle.db.select({ c: sql<number>`count(*)` }).from(categories))[0].c
      ),
    };

    const fd = new FormData();
    fd.append('files', makeFile('a.md', '# A'));
    fd.append('files', makeFile('b.md', '# B\n\n[[A]]'));
    fd.append('files', makeFile('characters/c.md', '# C'));
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(200);

    const after = {
      entries: Number((await handle.db.select({ c: sql<number>`count(*)` }).from(entries))[0].c),
      links: Number((await handle.db.select({ c: sql<number>`count(*)` }).from(links))[0].c),
      categories: Number(
        (await handle.db.select({ c: sql<number>`count(*)` }).from(categories))[0].c
      ),
    };

    expect(after.entries).toBe(before.entries);
    expect(after.links).toBe(before.links);
    expect(after.categories).toBe(before.categories);
  });

  // ─── 413 batch-limit cases ──────────────────────────────────────────────

  it('413 file_count: returns 413 when more than 1000 file parts uploaded', async () => {
    const { userId, jwt } = await createUserAndJwt('413-count@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    for (let i = 0; i < 1001; i++) {
      fd.append('files', makeFile(`f${i}.md`, '# x'));
    }
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/file_count/);
    expect(String(res.body.error)).toMatch(/1000/);
  });

  it('413 file_size: returns 413 when an individual .md file exceeds 1 MB', async () => {
    const { userId, jwt } = await createUserAndJwt('413-size@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    // Just over 1 MB (1*1024*1024 + 1 bytes).
    const big = 'x'.repeat(1 * 1024 * 1024 + 1);
    fd.append('files', makeFile('big.md', big));
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/file_size/);
  });

  it('413 zip_size: returns 413 when zip is over 50 MB', async () => {
    const { userId, jwt } = await createUserAndJwt('413-zip@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    // 50 MB + 1 byte. Generated as a Buffer, declared as a zip File even though
    // the bytes are not a real zip — endpoint MUST short-circuit on size BEFORE
    // attempting to unpack (size-check-before-arrayBuffer technique).
    const oversized = Buffer.alloc(50 * 1024 * 1024 + 1, 0);
    fd.append('zip', makeZipFile('huge.zip', oversized));
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/zip_size/);
  });

  it('413 zip-bomb: rejected in <2 seconds by the file_size preflight (D-15b streaming abort)', async () => {
    const { userId, jwt } = await createUserAndJwt('413-bomb@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    fd.append('zip', makeZipFile('bomb.zip', readFileSync(ZIP_BOMB_ZIP)));
    const start = Date.now();
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    const elapsed = Date.now() - start;

    // D-15b is "the bomb is rejected, fast, without decompressing it" — that
    // invariant is what this asserts. WHICH named guard trips is a function of
    // the production limits, and at those limits it is file_size, not
    // total_uncompressed_size:
    //
    //   The bomb is a single large-file bomb. unpackZip's guards run in order
    //   file_count -> file_size -> total_uncompressed_size, and the file_size
    //   check is a PREFLIGHT against the zip entry's uncompressedSize header
    //   (ingest-zip.ts:145). At the route's real maxFileSize (1 MiB) the bomb's
    //   declared size blows that immediately, so it is refused on the header —
    //   without inflating a single byte. That is a STRICTLY BETTER defense than
    //   the per-chunk cumulative accumulator, which can only fire once you have
    //   already started decompressing.
    //
    //   total_uncompressed_size is the backstop for bombs that slip past the
    //   per-file check (many files each under the cap, summing over the total).
    //   It is exercised directly in ingest-zip.test.ts, which has to raise
    //   maxFileSize to 200 MB to reach it — see its "allow per-file bigger so we
    //   hit the CUMULATIVE cap, not file_size" comment. This fixture cannot
    //   reach that guard at production limits.
    //
    // The original assertion (/total_uncompressed_size/) therefore named a guard
    // that is structurally unreachable here. The bomb defense was never broken.
    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/file_size/);
    expect(elapsed).toBeLessThan(2_000);
  });

  // ─── 400 cases ───────────────────────────────────────────────────────────

  it('400: returns 400 when neither files nor zip is provided', async () => {
    const { userId, jwt } = await createUserAndJwt('400-empty@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    fd.append('other', 'hi');
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(400);
  });

  it('400: returns 400 when both files and zip are provided', async () => {
    const { userId, jwt } = await createUserAndJwt('400-both@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    fd.append('files', makeFile('a.md', '# A'));
    fd.append('zip', makeZipFile('v.zip', readFileSync(VALID_VAULT_ZIP)));
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(400);
  });

  it('400: returns 400 when zip part has bad magic bytes (not a valid ZIP)', async () => {
    const { userId, jwt } = await createUserAndJwt('400-magic@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    // Bytes that are NOT a ZIP local-file-header (PK\x03\x04).
    const fake = Buffer.from('not-a-zip-archive-content', 'utf8');
    fd.append('zip', makeZipFile('fake.zip', fake));
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(400);
  });

  it('400: rejects path-traversal entries (T-11-05 defense-in-depth)', async () => {
    const { userId, jwt } = await createUserAndJwt('400-traversal@test.com');
    const u = await createUniverse(userId);
    const fd = new FormData();
    fd.append('files', makeFile('../escape.md', '# escape'));
    const res = await ingestRequest(u.id, fd, `Bearer ${jwt}`);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/Invalid path/);
  });

  // ─── Split preview metadata (#37 SP-04) ─────────────────────────────────

  describe('preview split metadata (SP-04)', () => {
    it('reports eligibility, the detected level and per-level counts', async () => {
      const res = await postPreview({
        files: [{ path: 'regions.md', content: '# R\n\n## Vale\n\nA.\n\n## Frostmere\n\nB.\n' }],
      });
      const body = await res.json();
      expect(body.split.eligible).toBe(true);
      expect(body.split.detected).toBe(2);
      expect(body.split.applied).toBe(2);
      expect(body.split.counts['2']).toBe(2);
    });

    it('is ineligible for a multi-file batch', async () => {
      const res = await postPreview({
        files: [
          { path: 'a.md', content: '## One\n\nA.\n\n## Two\n\nB.\n' },
          { path: 'b.md', content: '## Three\n\nC.\n' },
        ],
      });
      const body = await res.json();
      expect(body.split.eligible).toBe(false);
      expect(body.split.applied).toBeNull();
    });

    it('honours an explicit split_level over the detected one', async () => {
      const res = await postPreview({
        files: [{ path: 'r.md', content: '# A\n\n## B\n\nx.\n\n# C\n\n## D\n\ny.\n' }],
        split_level: 2,
      });
      const body = await res.json();
      expect(body.split.detected).toBe(1);
      expect(body.split.applied).toBe(2);
    });

    it('split_level: null means do not split, even when a level was detected', async () => {
      const res = await postPreview({
        files: [{ path: 'r.md', content: '## Vale\n\nA.\n\n## Frostmere\n\nB.\n' }],
        split_level: null,
      });
      const body = await res.json();
      expect(body.split.detected).toBe(2);
      expect(body.split.applied).toBeNull();
      expect(body.entries).toHaveLength(1);
    });

    it('rejects a post-split entry count above the batch cap', async () => {
      const many = Array.from({ length: 5000 }, (_, i) => `## S${i}\n\nB${i}.\n`).join('\n');
      const res = await postPreview({ files: [{ path: 'r.md', content: many }], split_level: 2 });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toMatch(/file_count|limit/i);
    });
  });

  // ─── OpenAPI doc presence ────────────────────────────────────────────────

  it('GET /api/openapi.json includes /universes/{uid}/ingest with bearerAuth security', async () => {
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, { post?: { security?: Array<Record<string, unknown>> } }>;
    };
    const ingestPath = doc.paths['/universes/{uid}/ingest'];
    expect(ingestPath).toBeTruthy();
    expect(ingestPath.post).toBeTruthy();
    expect(ingestPath.post!.security).toEqual(
      expect.arrayContaining([expect.objectContaining({ bearerAuth: [] })])
    );
  });
});
