import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('entry routes (ENT-01..06)', () => {
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

  async function req(method: string, path: string, opts?: { headers?: Record<string, string>; body?: unknown }) {
    const url = `http://localhost${path}`;
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(url, init);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  /** Create a universe and return its id */
  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/universes', { headers: hdrs, body: { name } });
    const body = await json(res);
    return body;
  }

  // ENT-01: create entry with all fields
  it('POST /universes/:uid/entries creates entry with all fields', async () => {
    const { hdrs } = await userWithToken('a@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: {
        title: 'The Sundering',
        entryType: 'event',
        summary: 'The world-splitting cataclysm',
        body: '# Details\n\nThe Sundering happened long ago.',
        tags: ['cataclysm', 'history'],
        meta: { era: 'First Age', severity: 'catastrophic' },
        icon: '💥',
      },
    });

    expect(res.status).toBe(201);
    const entry = await json(res);
    expect(entry.title).toBe('The Sundering');
    expect(entry.entryType).toBe('event');
    expect(entry.summary).toBe('The world-splitting cataclysm');
    expect(entry.body).toBe('# Details\n\nThe Sundering happened long ago.');
    expect(entry.tags).toEqual(['cataclysm', 'history']);
    expect(entry.meta).toEqual({ era: 'First Age', severity: 'catastrophic' });
    expect(entry.icon).toBe('💥');
    expect(entry.universeId).toBe(universe.id);
    expect(typeof entry.id).toBe('string');
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
  });

  // ENT-01: create entry with minimal fields (defaults)
  it('POST /universes/:uid/entries creates entry with defaults', async () => {
    const { hdrs } = await userWithToken('b@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Minimal Entry', entryType: 'concept' },
    });

    expect(res.status).toBe(201);
    const entry = await json(res);
    expect(entry.summary).toBe('');
    expect(entry.body).toBe('');
    expect(entry.tags).toEqual([]);
    expect(entry.icon).toBe('');
  });

  // ENT-06: title required validation
  it('POST /universes/:uid/entries rejects missing title with 400', async () => {
    const { hdrs } = await userWithToken('c@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { entryType: 'concept' },
    });
    expect(res.status).toBe(400);
  });

  // ENT-06: entryType must be in universe.entryTypes
  it('POST /universes/:uid/entries validates entryType against universe types', async () => {
    const { hdrs } = await userWithToken('d@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Bad Type', entryType: 'nonexistent_type' },
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBeTruthy();
  });

  // ENT-05: list entries excludes body, ordered by updatedAt desc
  it('GET /universes/:uid/entries returns entries without body, ordered by updatedAt desc', async () => {
    const { hdrs } = await userWithToken('e@test.com');
    const universe = await createUniverse(hdrs);

    // Create two entries with a small delay to ensure different updatedAt
    await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'First Entry', entryType: 'concept', body: 'body1' },
    });

    // Brief delay to differentiate timestamps
    await new Promise(r => setTimeout(r, 50));

    await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Second Entry', entryType: 'entity', body: 'body2' },
    });

    const res = await req('GET', `/universes/${universe.id}/entries`, { headers: hdrs });
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(list).toHaveLength(2);

    // Ordered by updatedAt desc -- second entry first
    expect(list[0].title).toBe('Second Entry');
    expect(list[1].title).toBe('First Entry');

    // Body should NOT be present in list response
    expect(list[0]).not.toHaveProperty('body');
    expect(list[1]).not.toHaveProperty('body');
  });

  // ENT-04: get entry detail includes body
  it('GET /universes/:uid/entries/:id returns full entry with body', async () => {
    const { hdrs } = await userWithToken('f@test.com');
    const universe = await createUniverse(hdrs);

    const createRes = await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Detailed Entry', entryType: 'location', body: '# My Location\n\nA beautiful place.' },
    });
    const created = await json(createRes);

    const res = await req('GET', `/universes/${universe.id}/entries/${created.id}`, { headers: hdrs });
    expect(res.status).toBe(200);
    const entry = await json(res);
    expect(entry.title).toBe('Detailed Entry');
    expect(entry.body).toBe('# My Location\n\nA beautiful place.');
  });

  // ENT-04: nonexistent entry returns 404
  it('GET /universes/:uid/entries/:id returns 404 for nonexistent entry', async () => {
    const { hdrs } = await userWithToken('g@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('GET', `/universes/${universe.id}/entries/00000000-0000-0000-0000-000000000000`, { headers: hdrs });
    expect(res.status).toBe(404);
  });

  // ENT-02: update entry fields
  it('PATCH /universes/:uid/entries/:id updates provided fields', async () => {
    const { hdrs } = await userWithToken('h@test.com');
    const universe = await createUniverse(hdrs);

    const createRes = await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Original', entryType: 'concept', summary: 'Old summary' },
    });
    const created = await json(createRes);

    const res = await req('PATCH', `/universes/${universe.id}/entries/${created.id}`, {
      headers: hdrs,
      body: { title: 'Updated', summary: 'New summary' },
    });
    expect(res.status).toBe(200);
    const updated = await json(res);
    expect(updated.title).toBe('Updated');
    expect(updated.summary).toBe('New summary');
    expect(updated.entryType).toBe('concept'); // unchanged
  });

  // ENT-03: delete entry
  it('DELETE /universes/:uid/entries/:id returns 204 then 404 on get', async () => {
    const { hdrs } = await userWithToken('i@test.com');
    const universe = await createUniverse(hdrs);

    const createRes = await req('POST', `/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Doomed', entryType: 'artifact' },
    });
    const created = await json(createRes);

    const delRes = await req('DELETE', `/universes/${universe.id}/entries/${created.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    const getRes = await req('GET', `/universes/${universe.id}/entries/${created.id}`, { headers: hdrs });
    expect(getRes.status).toBe(404);
  });

  // Cross-tenant: 403 for wrong owner
  it('cross-tenant access returns 403', async () => {
    const a = await userWithToken('owner@test.com');
    const b = await userWithToken('stranger@test.com');
    const universe = await createUniverse(a.hdrs);

    // Create entry as owner
    const createRes = await req('POST', `/universes/${universe.id}/entries`, {
      headers: a.hdrs,
      body: { title: 'Private', entryType: 'concept' },
    });
    const created = await json(createRes);

    // Stranger tries list
    const listRes = await req('GET', `/universes/${universe.id}/entries`, { headers: b.hdrs });
    expect(listRes.status).toBe(403);

    // Stranger tries get detail
    const getRes = await req('GET', `/universes/${universe.id}/entries/${created.id}`, { headers: b.hdrs });
    expect(getRes.status).toBe(403);

    // Stranger tries create
    const postRes = await req('POST', `/universes/${universe.id}/entries`, {
      headers: b.hdrs,
      body: { title: 'Hijack', entryType: 'concept' },
    });
    expect(postRes.status).toBe(403);

    // Stranger tries update
    const patchRes = await req('PATCH', `/universes/${universe.id}/entries/${created.id}`, {
      headers: b.hdrs,
      body: { title: 'Hijacked' },
    });
    expect(patchRes.status).toBe(403);

    // Stranger tries delete
    const deleteRes = await req('DELETE', `/universes/${universe.id}/entries/${created.id}`, { headers: b.hdrs });
    expect(deleteRes.status).toBe(403);
  });

  // Nonexistent universe returns 404
  it('nonexistent universe returns 404', async () => {
    const { hdrs } = await userWithToken('j@test.com');
    const res = await req('GET', '/universes/00000000-0000-0000-0000-000000000000/entries', { headers: hdrs });
    expect(res.status).toBe(404);
  });

  // --- Link integration tests (LINK-04, LINK-05, LINK-06) ---

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const defaults = { title: 'Test Entry', entryType: 'concept' };
    const res = await req('POST', `/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  async function createLink(uid: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('POST', `/universes/${uid}/links`, {
      headers: hdrs,
      body,
    });
    return json(res);
  }

  // LINK-04: entry detail includes outbound links
  it('GET entry detail includes outbound links with target title and icon', async () => {
    const { hdrs } = await userWithToken('link1@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A', icon: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B', icon: 'B' });

    await createLink(universe.id, hdrs, {
      sourceEntryId: entryA.id,
      targetEntryId: entryB.id,
      label: 'created by',
    });

    const res = await req('GET', `/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
    expect(res.status).toBe(200);
    const detail = await json(res);

    expect(detail.outboundLinks).toHaveLength(1);
    expect(detail.outboundLinks[0].targetEntryId).toBe(entryB.id);
    expect(detail.outboundLinks[0].targetTitle).toBe('Entry B');
    expect(detail.outboundLinks[0].targetIcon).toBe('B');
    expect(detail.outboundLinks[0].label).toBe('created by');
    expect(detail.outboundLinks[0].bidirectional).toBe(false);
    expect(detail.outboundLinks[0].id).toBeTruthy();
  });

  // LINK-05: entry detail includes backlinks
  it('GET entry detail includes backlinks with source title and icon', async () => {
    const { hdrs } = await userWithToken('link2@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A', icon: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B', icon: 'B' });

    await createLink(universe.id, hdrs, {
      sourceEntryId: entryA.id,
      targetEntryId: entryB.id,
      label: 'created by',
    });

    // B should have a backlink from A
    const res = await req('GET', `/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
    expect(res.status).toBe(200);
    const detail = await json(res);

    expect(detail.backlinks).toHaveLength(1);
    expect(detail.backlinks[0].sourceEntryId).toBe(entryA.id);
    expect(detail.backlinks[0].sourceTitle).toBe('Entry A');
    expect(detail.backlinks[0].sourceIcon).toBe('A');
    expect(detail.backlinks[0].label).toBe('created by');
    expect(detail.backlinks[0].bidirectional).toBe(false);
  });

  // LINK-02/04/05: bidirectional link shows in both directions
  it('bidirectional link shows bidirectional=true in both outbound and backlink', async () => {
    const { hdrs } = await userWithToken('link3@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B' });

    await createLink(universe.id, hdrs, {
      sourceEntryId: entryA.id,
      targetEntryId: entryB.id,
      label: 'allied with',
      bidirectional: true,
    });

    // A's outbound should show bidirectional=true
    const resA = await req('GET', `/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
    const detailA = await json(resA);
    expect(detailA.outboundLinks).toHaveLength(1);
    expect(detailA.outboundLinks[0].bidirectional).toBe(true);

    // B's backlinks should show bidirectional=true
    const resB = await req('GET', `/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
    const detailB = await json(resB);
    expect(detailB.backlinks).toHaveLength(1);
    expect(detailB.backlinks[0].bidirectional).toBe(true);
  });

  // LINK-06: cascade delete removes links
  it('cascade delete removes links when entry is deleted', async () => {
    const { hdrs } = await userWithToken('link4@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B' });

    await createLink(universe.id, hdrs, {
      sourceEntryId: entryA.id,
      targetEntryId: entryB.id,
      label: 'created by',
    });

    // Delete entry A
    const delRes = await req('DELETE', `/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    // B should now have no backlinks from A
    const resB = await req('GET', `/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
    const detailB = await json(resB);
    expect(detailB.backlinks).toHaveLength(0);

    // Links list should be empty
    const linksRes = await req('GET', `/universes/${universe.id}/links`, { headers: hdrs });
    const linksList = await json(linksRes);
    expect(linksList).toHaveLength(0);
  });

  // LINK-06: cascade delete -- no orphaned backlinks (3-way scenario)
  it('cascade delete: no orphaned backlinks in multi-entry graph', async () => {
    const { hdrs } = await userWithToken('link5@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B' });
    const entryC = await createEntry(universe.id, hdrs, { title: 'Entry C' });

    // A -> B (A is source)
    await createLink(universe.id, hdrs, {
      sourceEntryId: entryA.id,
      targetEntryId: entryB.id,
      label: 'contains',
    });

    // C -> A (C is source, A is target)
    await createLink(universe.id, hdrs, {
      sourceEntryId: entryC.id,
      targetEntryId: entryA.id,
      label: 'references',
    });

    // Delete A -- should cascade both links
    const delRes = await req('DELETE', `/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    // B should have no backlinks from A
    const resB = await req('GET', `/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
    const detailB = await json(resB);
    expect(detailB.backlinks).toHaveLength(0);

    // C should have no outbound to A
    const resC = await req('GET', `/universes/${universe.id}/entries/${entryC.id}`, { headers: hdrs });
    const detailC = await json(resC);
    expect(detailC.outboundLinks).toHaveLength(0);

    // Links list should be empty
    const linksRes = await req('GET', `/universes/${universe.id}/links`, { headers: hdrs });
    const linksList = await json(linksRes);
    expect(linksList).toHaveLength(0);
  });
});
