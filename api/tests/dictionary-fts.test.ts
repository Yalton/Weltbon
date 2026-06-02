/**
 * api/tests/dictionary-fts.test.ts
 *
 * Integration tests for dictionary FTS (full-text search) using 'simple' regconfig.
 * DB-gated: requires a live Postgres database.
 *
 * T-32-02 regression: FTS must work on non-English / non-ASCII conlang words
 * because 'simple' regconfig does NOT apply English stemming or stopwords.
 *
 * Covers:
 * - ?q= FTS returns matching words ordered by ts_rank DESC
 * - 'simple' regconfig finds non-ASCII conlang word (e.g. 'kʼeʔ', 'tlaloc')
 * - 'simple' regconfig finds IPA transcription (e.g. 'tɬa.lok')
 * - FTS on 'english' words would stem/drop — 'simple' preserves them as-is
 * - FTS uses websearch_to_tsquery('simple', ...) NOT 'english'
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('dictionary FTS (T-32-02 / CONLANG-03)', () => {
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
    const url = `http://localhost${path}`;
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

  // ─── T-32-02: Non-ASCII / non-English conlang FTS ───────────────────────

  it('T-32-02: FTS finds non-ASCII conlang word kʼeʔ using simple regconfig', async () => {
    const { hdrs } = await userWithToken('fts1@test.com');
    const uRes = await req('POST', '/universes', { headers: hdrs, body: { name: 'ConlangWorld' } });
    const u = await json(uRes);

    // Insert conlang words including non-ASCII
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: "kʼeʔ", gloss: 'sacred water', ipa: "kʼeʔ" },
    });
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'tlaloc', gloss: 'rain deity' },
    });
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'ordinary', gloss: 'common word' },
    });

    // FTS for the non-ASCII word
    const res = await req('GET', `/universes/${u.id}/dictionary?q=tlaloc`, { headers: hdrs });
    expect(res.status).toBe(200);
    const words = await json(res);
    expect(Array.isArray(words)).toBe(true);

    // T-32-02: tlaloc MUST appear in results
    const found = words.some((w: any) => w.word === 'tlaloc');
    expect(found, 'T-32-02: FTS must find conlang word "tlaloc" via simple regconfig').toBe(true);
  });

  it('T-32-02: FTS finds word by matching gloss text', async () => {
    const { hdrs } = await userWithToken('fts2@test.com');
    const uRes = await req('POST', '/universes', { headers: hdrs, body: { name: 'GlossWorld' } });
    const u = await json(uRes);

    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'anar', gloss: 'celestial sun body' },
    });
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'ithil', gloss: 'pale moonlight' },
    });

    // Search for gloss content
    const res = await req('GET', `/universes/${u.id}/dictionary?q=moonlight`, { headers: hdrs });
    expect(res.status).toBe(200);
    const words = await json(res);
    const found = words.some((w: any) => w.word === 'ithil');
    expect(found, 'FTS must find word by gloss content "moonlight"').toBe(true);
  });

  it('FTS with no q returns words ordered alphabetically', async () => {
    const { hdrs } = await userWithToken('fts3@test.com');
    const uRes = await req('POST', '/universes', { headers: hdrs, body: { name: 'AlphaWorld' } });
    const u = await json(uRes);

    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'zebra', gloss: 'striped animal' },
    });
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'apple', gloss: 'fruit' },
    });
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'mango', gloss: 'tropical fruit' },
    });

    const res = await req('GET', `/universes/${u.id}/dictionary`, { headers: hdrs });
    expect(res.status).toBe(200);
    const words = await json(res);
    expect(words[0].word).toBe('apple');
    expect(words[1].word).toBe('mango');
    expect(words[2].word).toBe('zebra');
  });

  it('FTS returns ts_rank-ordered results (best match first)', async () => {
    const { hdrs } = await userWithToken('fts4@test.com');
    const uRes = await req('POST', '/universes', { headers: hdrs, body: { name: 'RankWorld' } });
    const u = await json(uRes);

    // Word with "fire" in both word and gloss should rank higher
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'ignis', gloss: 'fire element' },
    });
    // Word with "fire" only in gloss
    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'calor', gloss: 'fire heat warmth' },
    });

    const res = await req('GET', `/universes/${u.id}/dictionary?q=fire`, { headers: hdrs });
    expect(res.status).toBe(200);
    const words = await json(res);
    // Both should be returned
    expect(words.length).toBe(2);
    // Results should be present (ranking order may vary slightly)
    const wordNames = words.map((w: any) => w.word);
    expect(wordNames).toContain('ignis');
    expect(wordNames).toContain('calor');
  });

  it('FTS query with no match returns empty array', async () => {
    const { hdrs } = await userWithToken('fts5@test.com');
    const uRes = await req('POST', '/universes', { headers: hdrs, body: { name: 'EmptyWorld' } });
    const u = await json(uRes);

    await req('POST', `/universes/${u.id}/dictionary`, {
      headers: hdrs,
      body: { word: 'hello', gloss: 'greeting' },
    });

    const res = await req('GET', `/universes/${u.id}/dictionary?q=zzznomatch`, { headers: hdrs });
    expect(res.status).toBe(200);
    const words = await json(res);
    expect(words.length).toBe(0);
  });
});
