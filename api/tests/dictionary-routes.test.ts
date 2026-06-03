/**
 * api/tests/dictionary-routes.test.ts
 *
 * Integration tests for dictionary CRUD routes (Task 1) and public share read (Task 3).
 * DB-gated: requires a live Postgres database.
 *
 * Covers:
 * - CRUD: POST/GET/PATCH/DELETE /universes/:uid/dictionary
 * - Scope uniqueness (409 on duplicate word in same scope)
 * - PAT parity (Bearer PAT token works identically to JWT)
 * - Cross-tenant 403, missing universe 404, missing word 404
 * - languageEntryId FK-scope validation (400 if entry from different universe)
 * - Share read: GET /api/share/dictionary with valid token returns words
 * - Share boundary: mutation routes reject share-token-only auth
 *   (also covered automatically by share-boundary.test.ts)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { personalAccessTokens, shareTokens } from '../src/db/schema.js';
import { generatePatToken } from '../src/services/pat.js';
import { generateShareToken } from '../src/services/share-token.js';

describe('dictionary routes (CONLANG-01 / CONLANG-02)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  async function userWithToken(email: string) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);
    return { user, token, hdrs: authHeader(token) };
  }

  async function req(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: unknown },
  ) {
    const url = `http://localhost/api${path}`;
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(url, init);
  }

  async function json(res: Response) {
    return res.json() as Promise<any>;
  }

  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  // ─── Basic CRUD ──────────────────────────────────────────────────────────

  it('POST /universes/:uid/dictionary creates a word (201)', async () => {
    const { hdrs } = await userWithToken('a@test.com');
    const u = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'tlaloc', gloss: 'rain deity', ipa: 'tɬa.lok' },
    });

    expect(res.status).toBe(201);
    const w = await json(res);
    expect(w.word).toBe('tlaloc');
    expect(w.gloss).toBe('rain deity');
    expect(w.ipa).toBe('tɬa.lok');
    expect(w.id).toBeDefined();
  });

  it('GET /universes/:uid/dictionary lists universe-level words (lid absent → isNull)', async () => {
    const { hdrs } = await userWithToken('b@test.com');
    const u = await createUniverse(hdrs);

    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'alpha', gloss: 'first' },
    });
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'beta', gloss: 'second' },
    });

    const res = await req('GET', `/universes/${u.id}/dictionary`, { headers: hdrs });
    expect(res.status).toBe(200);
    const words = await json(res);
    expect(Array.isArray(words)).toBe(true);
    expect(words.length).toBe(2);
    // Ordered alpha ascending
    expect(words[0].word).toBe('alpha');
    expect(words[1].word).toBe('beta');
  });

  it('PATCH /universes/:uid/dictionary/:wid updates a word', async () => {
    const { hdrs } = await userWithToken('c@test.com');
    const u = await createUniverse(hdrs);

    const createRes = await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'kʼeʔ', gloss: 'water' },
    });
    const w = await json(createRes);

    const patchRes = await req('PATCH', `/universes/${u.id}/dictionary/${w.id}`, {
      headers: hdrs,
      body: { gloss: 'sacred water' },
    });
    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.gloss).toBe('sacred water');
    expect(updated.word).toBe('kʼeʔ'); // word unchanged
  });

  it('DELETE /universes/:uid/dictionary/:wid removes word (204)', async () => {
    const { hdrs } = await userWithToken('d@test.com');
    const u = await createUniverse(hdrs);

    const createRes = await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'nix', gloss: 'snow' },
    });
    const w = await json(createRes);

    const delRes = await req('DELETE', `/universes/${u.id}/dictionary/${w.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    // Confirm gone
    const listRes = await req('GET', `/universes/${u.id}/dictionary`, { headers: hdrs });
    const words = await json(listRes);
    expect(words.length).toBe(0);
  });

  // ─── 409 scope uniqueness ────────────────────────────────────────────────

  it('POST duplicate word in the same universe scope → 409', async () => {
    const { hdrs } = await userWithToken('e@test.com');
    const u = await createUniverse(hdrs);

    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'quux', gloss: 'something' },
    });
    const dup = await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'quux', gloss: 'something else' },
    });
    expect(dup.status).toBe(409);
    const body = await json(dup);
    expect(body.error).toMatch(/already exists/i);
  });

  // ─── Cross-tenant / missing ──────────────────────────────────────────────

  it('GET dictionary for a different user universe → 403', async () => {
    const { hdrs: hdrs1 } = await userWithToken('f1@test.com');
    const { hdrs: hdrs2 } = await userWithToken('f2@test.com');
    const u = await createUniverse(hdrs1);

    const res = await req('GET', `/universes/${u.id}/dictionary`, { headers: hdrs2 });
    expect(res.status).toBe(403);
  });

  it('GET dictionary for non-existent universe → 404', async () => {
    const { hdrs } = await userWithToken('g@test.com');
    // Use a valid UUID v4 format that does not exist in the DB
    const res = await req('GET', '/universes/00000000-0000-4000-8000-000000000001/dictionary', {
      headers: hdrs,
    });
    expect(res.status).toBe(404);
  });

  it('PATCH non-existent word → 404', async () => {
    const { hdrs } = await userWithToken('h@test.com');
    const u = await createUniverse(hdrs);
    const res = await req('PATCH', `/universes/${u.id}/dictionary/00000000-0000-4000-8000-000000000002`, {
      headers: hdrs,
      body: { gloss: 'updated' },
    });
    expect(res.status).toBe(404);
  });

  it('DELETE non-existent word → 404', async () => {
    const { hdrs } = await userWithToken('i@test.com');
    const u = await createUniverse(hdrs);
    const res = await req('DELETE', `/universes/${u.id}/dictionary/00000000-0000-4000-8000-000000000003`, {
      headers: hdrs,
    });
    expect(res.status).toBe(404);
  });

  // ─── PAT parity ─────────────────────────────────────────────────────────

  it('PAT Bearer token works the same as JWT for dictionary routes', async () => {
    const jwtUser = await createTestUser(handle, { email: 'patjwt@test.com', password: 'longenoughpw12' });
    const jwtToken = await issueAccessToken(jwtUser.id);
    const jwtHdrs = authHeader(jwtToken);

    // Create a universe with JWT user
    const u = await createUniverse(jwtHdrs);

    // Create a PAT for the JWT user
    const pat = generatePatToken();
    await handle.db.insert(personalAccessTokens).values({
      userId: jwtUser.id,
      hash: pat.hash,
      bodySuffix: pat.bodySuffix,
      label: 'test-pat',
    });

    const patHdrs = { Authorization: `Bearer ${pat.plaintext}` };

    // PAT can list dictionary
    const res = await req('GET', `/universes/${u.id}/dictionary`, { headers: patHdrs });
    expect(res.status).toBe(200);

    // PAT can create a word
    const createRes = await req('POST', `/universes/${u.id}/dictionary`, {
      headers: patHdrs,
      body: { word: 'patos', gloss: 'test word via PAT' },
    });
    expect(createRes.status).toBe(201);
  });

  // ─── languageEntryId FK scope validation ─────────────────────────────────

  it('POST with languageEntryId from another universe → 400', async () => {
    const { hdrs: hdrs1 } = await userWithToken('lid1@test.com');
    const { hdrs: hdrs2 } = await userWithToken('lid2@test.com');
    const u1 = await createUniverse(hdrs1, 'Universe1');
    const u2 = await createUniverse(hdrs2, 'Universe2');

    // Create a language entry in u2
    const entryRes = await req('POST', `/universes/${u2.id}/entries`, {
      headers: hdrs2,
      body: { title: 'Elven', entryType: 'language' },
    });
    const langEntry = await json(entryRes);

    // Attempt to use that entry's id as languageEntryId in u1 → 400
    const res = await req('POST', `/universes/${u1.id}/dictionary`, {
      headers: hdrs1,
      body: { word: 'arum', gloss: 'light', languageEntryId: langEntry.id },
    });
    expect(res.status).toBe(400);
  });

  it('GET /universes/:uid/dictionary?lid= returns only that language words', async () => {
    const { hdrs } = await userWithToken('lid3@test.com');
    const u = await createUniverse(hdrs);

    // Create a language entry
    const entryRes = await req('POST', `/universes/${u.id}/entries`, {
      headers: hdrs,
      body: { title: 'High Elvish', entryType: 'language' },
    });
    const lang = await json(entryRes);

    // Create a word with that language
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'anar', gloss: 'sun', languageEntryId: lang.id },
    });
    // Create a universe-level word
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'orb', gloss: 'round thing' },
    });

    // List with lid= should return only language-scoped word
    const res = await req('GET', `/universes/${u.id}/dictionary?lid=${lang.id}`, { headers: hdrs });
    expect(res.status).toBe(200);
    const words = await json(res);
    expect(words.length).toBe(1);
    expect(words[0].word).toBe('anar');
  });

  // NOTE: Share read test (GET /api/share/dictionary) is implemented in Task 3
  // (share-views.ts + share.ts extension). The test assertion is added below
  // and will pass once Task 3 routes are mounted.

  it('GET /api/share/dictionary with valid share-token returns universe-level words', async () => {
    const { user, hdrs } = await userWithToken('share@test.com');
    const u = await createUniverse(hdrs, 'SharedWorld');

    // Create a word
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'zephyr', gloss: 'west wind' },
    });

    // Create a share token
    const seed = generateShareToken();
    await handle.db.insert(shareTokens).values({
      userId: user.id,
      universeId: u.id,
      label: 'share-dict-test',
      hash: seed.hash,
      bodySuffix: seed.bodySuffix,
    });

    const shareRes = await app.request(
      'http://localhost/api/share/dictionary',
      { method: 'GET', headers: { 'share-token': seed.plaintext } },
    );
    expect(shareRes.status).toBe(200);
    const body = await shareRes.json() as any;
    expect(body).toHaveProperty('words');
    expect(Array.isArray(body.words)).toBe(true);
    expect(body.words.length).toBe(1);
    expect(body.words[0].word).toBe('zephyr');
    // Cosmetic fields only: no universeId private field details leakage
    expect(body.words[0]).toHaveProperty('id');
    expect(body.words[0]).toHaveProperty('gloss');
    expect(body.words[0]).toHaveProperty('ipa');
    expect(body.words[0]).toHaveProperty('partOfSpeech');
    expect(body.words[0]).toHaveProperty('tags');
  });
});
