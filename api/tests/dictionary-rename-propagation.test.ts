/**
 * api/tests/dictionary-rename-propagation.test.ts — issue #59.
 *
 * The planner's rules are unit-tested in rename-term.test.ts. What only a live
 * database shows is the part that makes the feature trustworthy: the preview
 * and the commit agree, the commit is atomic with the glossary row, an entry
 * the user did not accept is not touched, and language scope is computed from
 * real link rows rather than assumed.
 *
 * DB-gated.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { entries, links } from '../src/db/schema.js';

describe('dictionary term rename propagation (#59)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(`http://localhost/api${path}`, init);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = (res: Response) => res.json() as Promise<any>;

  async function createUniverse(hdrs: Record<string, string>) {
    return json(await req('POST', '/universes', { headers: hdrs, body: { name: 'Conlang World' } }));
  }

  async function createEntry(
    hdrs: Record<string, string>,
    uid: string,
    body: { title: string; body: string; entryType?: string },
  ) {
    return json(
      await req('POST', `/universes/${uid}/entries`, {
        headers: hdrs,
        body: { entryType: 'concept', ...body },
      }),
    );
  }

  async function createWord(
    hdrs: Record<string, string>,
    uid: string,
    body: Record<string, unknown>,
  ) {
    return json(
      await req('POST', `/universes/${uid}/dictionary`, {
        headers: hdrs,
        body: { gloss: 'a placeholder', ...body },
      }),
    );
  }

  it('preview reports per-entry counts and writes nothing', async () => {
    const { hdrs } = await userWithToken('prev@test.com');
    const u = await createUniverse(hdrs);
    const word = await createWord(hdrs, u.id, { word: 'ayin' });
    const note = await createEntry(hdrs, u.id, {
      title: 'Field notes',
      body: 'An ayin opens. See [[ayin]] and [[ayin|the pocket]].',
    });

    const res = await req('POST', `/universes/${u.id}/dictionary/${word.id}/rename-preview`, {
      headers: hdrs,
      body: { word: 'vaelin' },
    });
    expect(res.status).toBe(200);

    const preview = await json(res);
    expect(preview.word).toBe('ayin');
    expect(preview.newWord).toBe('vaelin');
    expect(preview.totalOccurrences).toBe(3);
    expect(preview.entries).toEqual([
      { entryId: note.id, title: 'Field notes', wikilinkCount: 2, textCount: 1 },
    ]);

    const [row] = await handle.db
      .select({ body: entries.body })
      .from(entries)
      .where(eq(entries.id, note.id));
    expect(row.body).toBe('An ayin opens. See [[ayin]] and [[ayin|the pocket]].');
  });

  it('rewrites only the accepted entries, atomically with the word', async () => {
    const { hdrs } = await userWithToken('commit@test.com');
    const u = await createUniverse(hdrs);
    const word = await createWord(hdrs, u.id, { word: 'ayin' });
    const accepted = await createEntry(hdrs, u.id, { title: 'Accepted', body: 'An ayin here.' });
    const declined = await createEntry(hdrs, u.id, { title: 'Declined', body: 'An ayin there.' });

    const res = await req('PATCH', `/universes/${u.id}/dictionary/${word.id}`, {
      headers: hdrs,
      body: { word: 'vaelin', propagate: { entryIds: [accepted.id] } },
    });
    expect(res.status).toBe(200);

    const updated = await json(res);
    expect(updated.word).toBe('vaelin');
    expect(updated.rewriteCount).toBe(1);
    expect(updated.entriesRewritten).toBe(1);

    const rows = await handle.db
      .select({ id: entries.id, body: entries.body })
      .from(entries)
      .where(eq(entries.universeId, u.id));
    const byId = new Map(rows.map((r) => [r.id, r.body]));
    expect(byId.get(accepted.id)).toBe('An vaelin here.');
    expect(byId.get(declined.id)).toBe('An ayin there.');
  });

  it('renames the glossary row alone when propagation is not requested', async () => {
    // The default has to stay the old behaviour: a rename that edits prose
    // without being asked is not recoverable from the UI.
    const { hdrs } = await userWithToken('default@test.com');
    const u = await createUniverse(hdrs);
    const word = await createWord(hdrs, u.id, { word: 'ayin' });
    const note = await createEntry(hdrs, u.id, { title: 'Note', body: 'An ayin.' });

    const res = await req('PATCH', `/universes/${u.id}/dictionary/${word.id}`, {
      headers: hdrs,
      body: { word: 'vaelin' },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).rewriteCount).toBe(0);

    const [row] = await handle.db
      .select({ body: entries.body })
      .from(entries)
      .where(eq(entries.id, note.id));
    expect(row.body).toBe('An ayin.');
  });

  it('scopes a language-bound term to entries linked to that language', async () => {
    const { hdrs } = await userWithToken('scope@test.com');
    const u = await createUniverse(hdrs);

    // The universe must accept a 'language' entry type for the scope rule to
    // have anything to attach to.
    await req('PATCH', `/universes/${u.id}`, {
      headers: hdrs,
      body: { entryTypes: ['concept', 'language'] },
    });

    const lang = await createEntry(hdrs, u.id, {
      title: 'High Ayinic',
      body: '',
      entryType: 'language',
    });
    const inScope = await createEntry(hdrs, u.id, { title: 'In scope', body: 'An ayin.' });
    const outOfScope = await createEntry(hdrs, u.id, { title: 'Out of scope', body: 'An ayin.' });

    // Only `inScope` links the language entry, so only it resolves the term.
    await handle.db.insert(links).values({
      universeId: u.id,
      sourceEntryId: inScope.id,
      targetEntryId: lang.id,
      direction: 'directed',
    });

    const word = await createWord(hdrs, u.id, { word: 'ayin', languageEntryId: lang.id });

    const preview = await json(
      await req('POST', `/universes/${u.id}/dictionary/${word.id}/rename-preview`, {
        headers: hdrs,
        body: { word: 'vaelin' },
      }),
    );

    expect(preview.entries.map((e: { entryId: string }) => e.entryId)).toEqual([inScope.id]);
    expect(preview.skipped).toEqual([
      { entryId: outOfScope.id, title: 'Out of scope', reason: 'out_of_scope', count: 1 },
    ]);
  });

  it('reports a case-differing occurrence rather than rewriting it', async () => {
    const { hdrs } = await userWithToken('case@test.com');
    const u = await createUniverse(hdrs);
    const word = await createWord(hdrs, u.id, { word: 'ayin' });
    const note = await createEntry(hdrs, u.id, {
      title: 'Note',
      body: 'Ayin is the term. An ayin opened.',
    });

    const preview = await json(
      await req('POST', `/universes/${u.id}/dictionary/${word.id}/rename-preview`, {
        headers: hdrs,
        body: { word: 'vaelin' },
      }),
    );
    expect(preview.skipped).toEqual([
      { entryId: note.id, title: 'Note', reason: 'case_mismatch', count: 1 },
    ]);

    await req('PATCH', `/universes/${u.id}/dictionary/${word.id}`, {
      headers: hdrs,
      body: { word: 'vaelin', propagate: { entryIds: [note.id] } },
    });

    const [row] = await handle.db
      .select({ body: entries.body })
      .from(entries)
      .where(eq(entries.id, note.id));
    expect(row.body).toBe('Ayin is the term. An vaelin opened.');
  });

  it('rejects a preview for a universe owned by someone else', async () => {
    const owner = await userWithToken('owner@test.com');
    const u = await createUniverse(owner.hdrs);
    const word = await createWord(owner.hdrs, u.id, { word: 'ayin' });
    const intruder = await userWithToken('intruder@test.com');

    const res = await req('POST', `/universes/${u.id}/dictionary/${word.id}/rename-preview`, {
      headers: intruder.hdrs,
      body: { word: 'vaelin' },
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a word that is not in this universe', async () => {
    const { hdrs } = await userWithToken('missing@test.com');
    const u = await createUniverse(hdrs);

    const res = await req(
      'POST',
      `/universes/${u.id}/dictionary/00000000-0000-0000-0000-000000000000/rename-preview`,
      { headers: hdrs, body: { word: 'vaelin' } },
    );
    expect(res.status).toBe(404);
  });
});
