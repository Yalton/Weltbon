import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { eq, and } from 'drizzle-orm';
import { entryTemplates } from '../src/db/schema.js';

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
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    const body = await json(res);
    return body;
  }

  // ENT-01: create entry with all fields
  it('POST /universes/:uid/entries creates entry with all fields', async () => {
    const { hdrs } = await userWithToken('a@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/api/universes/${universe.id}/entries`, {
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

    const res = await req('POST', `/api/universes/${universe.id}/entries`, {
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

    const res = await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { entryType: 'concept' },
    });
    expect(res.status).toBe(400);
  });

  // ENT-06: entryType must be in universe.entryTypes
  it('POST /universes/:uid/entries validates entryType against universe types', async () => {
    const { hdrs } = await userWithToken('d@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/api/universes/${universe.id}/entries`, {
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
    await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'First Entry', entryType: 'concept', body: 'body1' },
    });

    // Brief delay to differentiate timestamps
    await new Promise(r => setTimeout(r, 50));

    await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Second Entry', entryType: 'entity', body: 'body2' },
    });

    const res = await req('GET', `/api/universes/${universe.id}/entries`, { headers: hdrs });
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

    const createRes = await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Detailed Entry', entryType: 'location', body: '# My Location\n\nA beautiful place.' },
    });
    const created = await json(createRes);

    const res = await req('GET', `/api/universes/${universe.id}/entries/${created.id}`, { headers: hdrs });
    expect(res.status).toBe(200);
    const entry = await json(res);
    expect(entry.title).toBe('Detailed Entry');
    expect(entry.body).toBe('# My Location\n\nA beautiful place.');
  });

  // ENT-04: nonexistent entry returns 404
  it('GET /universes/:uid/entries/:id returns 404 for nonexistent entry', async () => {
    const { hdrs } = await userWithToken('g@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('GET', `/api/universes/${universe.id}/entries/00000000-0000-0000-0000-000000000000`, { headers: hdrs });
    expect(res.status).toBe(404);
  });

  // ENT-02: update entry fields
  it('PATCH /universes/:uid/entries/:id updates provided fields', async () => {
    const { hdrs } = await userWithToken('h@test.com');
    const universe = await createUniverse(hdrs);

    const createRes = await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Original', entryType: 'concept', summary: 'Old summary' },
    });
    const created = await json(createRes);

    const res = await req('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, {
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

    const createRes = await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Doomed', entryType: 'artifact' },
    });
    const created = await json(createRes);

    const delRes = await req('DELETE', `/api/universes/${universe.id}/entries/${created.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    const getRes = await req('GET', `/api/universes/${universe.id}/entries/${created.id}`, { headers: hdrs });
    expect(getRes.status).toBe(404);
  });

  // Cross-tenant: 403 for wrong owner
  it('cross-tenant access returns 403', async () => {
    const a = await userWithToken('owner@test.com');
    const b = await userWithToken('stranger@test.com');
    const universe = await createUniverse(a.hdrs);

    // Create entry as owner
    const createRes = await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: a.hdrs,
      body: { title: 'Private', entryType: 'concept' },
    });
    const created = await json(createRes);

    // Stranger tries list
    const listRes = await req('GET', `/api/universes/${universe.id}/entries`, { headers: b.hdrs });
    expect(listRes.status).toBe(403);

    // Stranger tries get detail
    const getRes = await req('GET', `/api/universes/${universe.id}/entries/${created.id}`, { headers: b.hdrs });
    expect(getRes.status).toBe(403);

    // Stranger tries create
    const postRes = await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: b.hdrs,
      body: { title: 'Hijack', entryType: 'concept' },
    });
    expect(postRes.status).toBe(403);

    // Stranger tries update
    const patchRes = await req('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, {
      headers: b.hdrs,
      body: { title: 'Hijacked' },
    });
    expect(patchRes.status).toBe(403);

    // Stranger tries delete
    const deleteRes = await req('DELETE', `/api/universes/${universe.id}/entries/${created.id}`, { headers: b.hdrs });
    expect(deleteRes.status).toBe(403);
  });

  // Nonexistent universe returns 404
  it('nonexistent universe returns 404', async () => {
    const { hdrs } = await userWithToken('j@test.com');
    const res = await req('GET', '/api/universes/00000000-0000-0000-0000-000000000000/entries', { headers: hdrs });
    expect(res.status).toBe(404);
  });

  // --- Link integration tests (LINK-04, LINK-05, LINK-06) ---

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const defaults = { title: 'Test Entry', entryType: 'concept' };
    const res = await req('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  async function createLink(uid: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('POST', `/api/universes/${uid}/links`, {
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

    const res = await req('GET', `/api/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
    expect(res.status).toBe(200);
    const detail = await json(res);

    expect(detail.outboundLinks).toHaveLength(1);
    expect(detail.outboundLinks[0].targetEntryId).toBe(entryB.id);
    expect(detail.outboundLinks[0].targetTitle).toBe('Entry B');
    expect(detail.outboundLinks[0].targetIcon).toBe('B');
    expect(detail.outboundLinks[0].label).toBe('created by');
    // Phase 35 REL-01: bidirectional replaced by direction ('directed'|'undirected')
    expect(detail.outboundLinks[0].direction).toBe('directed');
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
    const res = await req('GET', `/api/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
    expect(res.status).toBe(200);
    const detail = await json(res);

    expect(detail.backlinks).toHaveLength(1);
    expect(detail.backlinks[0].sourceEntryId).toBe(entryA.id);
    expect(detail.backlinks[0].sourceTitle).toBe('Entry A');
    expect(detail.backlinks[0].sourceIcon).toBe('A');
    expect(detail.backlinks[0].label).toBe('created by');
    // Phase 35 REL-01: bidirectional replaced by direction ('directed'|'undirected')
    expect(detail.backlinks[0].direction).toBe('directed');
  });

  // LINK-02/04/05: undirected link shows direction=undirected in both directions
  // Phase 35 REL-01: bidirectional bool replaced by direction enum ('directed'|'undirected')
  it('undirected link shows direction=undirected in both outbound and backlink', async () => {
    const { hdrs } = await userWithToken('link3@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B' });

    await createLink(universe.id, hdrs, {
      sourceEntryId: entryA.id,
      targetEntryId: entryB.id,
      label: 'allied with',
      direction: 'undirected',
    });

    // A's outbound should show direction=undirected
    const resA = await req('GET', `/api/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
    const detailA = await json(resA);
    expect(detailA.outboundLinks).toHaveLength(1);
    expect(detailA.outboundLinks[0].direction).toBe('undirected');

    // B's backlinks should show direction=undirected
    const resB = await req('GET', `/api/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
    const detailB = await json(resB);
    expect(detailB.backlinks).toHaveLength(1);
    expect(detailB.backlinks[0].direction).toBe('undirected');
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
    const delRes = await req('DELETE', `/api/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    // B should now have no backlinks from A
    const resB = await req('GET', `/api/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
    const detailB = await json(resB);
    expect(detailB.backlinks).toHaveLength(0);

    // Links list should be empty
    const linksRes = await req('GET', `/api/universes/${universe.id}/links`, { headers: hdrs });
    const linksList = await json(linksRes);
    expect(linksList).toHaveLength(0);
  });

  // --- CAT-02: category assignment on entries ---

  async function createCategory(uid: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('POST', `/api/universes/${uid}/categories`, { headers: hdrs, body });
    return json(res);
  }

  it('POST entry accepts optional categoryId and stores it', async () => {
    const { hdrs } = await userWithToken('entry-cat1@test.com');
    const universe = await createUniverse(hdrs);
    const cat = await createCategory(universe.id, hdrs, { label: 'Factions' });

    const res = await req('POST', `/api/universes/${universe.id}/entries`, {
      headers: hdrs,
      body: { title: 'Guild', entryType: 'faction', categoryId: cat.id },
    });
    expect(res.status).toBe(201);
    const entry = await json(res);
    expect(entry.categoryId).toBe(cat.id);
  });

  it('POST entry rejects categoryId from a different universe with 400', async () => {
    const { hdrs } = await userWithToken('entry-cat2@test.com');
    const uniA = await createUniverse(hdrs, 'A');
    const uniB = await createUniverse(hdrs, 'B');
    const catB = await createCategory(uniB.id, hdrs, { label: 'InB' });

    const res = await req('POST', `/api/universes/${uniA.id}/entries`, {
      headers: hdrs,
      body: { title: 'X', entryType: 'concept', categoryId: catB.id },
    });
    expect(res.status).toBe(400);
  });

  it('PATCH entry with valid categoryId succeeds and GET returns new categoryId', async () => {
    const { hdrs } = await userWithToken('entry-cat3@test.com');
    const universe = await createUniverse(hdrs);
    const cat = await createCategory(universe.id, hdrs, { label: 'Locations' });
    const created = await createEntry(universe.id, hdrs, { title: 'Citadel' });

    const patchRes = await req('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, {
      headers: hdrs,
      body: { categoryId: cat.id },
    });
    expect(patchRes.status).toBe(200);

    const getRes = await req('GET', `/api/universes/${universe.id}/entries/${created.id}`, { headers: hdrs });
    const entry = await json(getRes);
    expect(entry.categoryId).toBe(cat.id);
  });

  it('PATCH entry with categoryId:null clears category assignment', async () => {
    const { hdrs } = await userWithToken('entry-cat4@test.com');
    const universe = await createUniverse(hdrs);
    const cat = await createCategory(universe.id, hdrs, { label: 'Locations' });
    const created = await createEntry(universe.id, hdrs, { title: 'Citadel' });

    await req('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, {
      headers: hdrs,
      body: { categoryId: cat.id },
    });
    const patchRes = await req('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, {
      headers: hdrs,
      body: { categoryId: null },
    });
    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.categoryId).toBeNull();
  });

  it('PATCH entry with categoryId from a different universe returns 400', async () => {
    const { hdrs } = await userWithToken('entry-cat5@test.com');
    const uniA = await createUniverse(hdrs, 'A');
    const uniB = await createUniverse(hdrs, 'B');
    const catB = await createCategory(uniB.id, hdrs, { label: 'InB' });
    const entryA = await createEntry(uniA.id, hdrs, { title: 'In A' });

    const res = await req('PATCH', `/api/universes/${uniA.id}/entries/${entryA.id}`, {
      headers: hdrs,
      body: { categoryId: catB.id },
    });
    expect(res.status).toBe(400);
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
    const delRes = await req('DELETE', `/api/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    // B should have no backlinks from A
    const resB = await req('GET', `/api/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
    const detailB = await json(resB);
    expect(detailB.backlinks).toHaveLength(0);

    // C should have no outbound to A
    const resC = await req('GET', `/api/universes/${universe.id}/entries/${entryC.id}`, { headers: hdrs });
    const detailC = await json(resC);
    expect(detailC.outboundLinks).toHaveLength(0);

    // Links list should be empty
    const linksRes = await req('GET', `/api/universes/${universe.id}/links`, { headers: hdrs });
    const linksList = await json(linksRes);
    expect(linksList).toHaveLength(0);
  });

  // --- ISS-06: GET /:id includes open issues ---

  async function createIssue(uid: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('POST', `/api/universes/${uid}/issues`, { headers: hdrs, body });
    return json(res);
  }

  async function patchIssue(uid: string, issueId: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('PATCH', `/api/universes/${uid}/issues/${issueId}`, { headers: hdrs, body });
    return json(res);
  }

  describe('GET /:id includes open issues (ISS-06)', () => {
    it('surfaces an open issue associated with the entry', async () => {
      const { hdrs } = await userWithToken('iss06a@test.com');
      const universe = await createUniverse(hdrs);
      const entry = await createEntry(universe.id, hdrs, { title: 'Protagonist' });

      const issue = await createIssue(universe.id, hdrs, {
        title: 'Age inconsistency',
        severity: 'major',
        entryIds: [entry.id],
      });

      const res = await req('GET', `/api/universes/${universe.id}/entries/${entry.id}`, { headers: hdrs });
      expect(res.status).toBe(200);
      const detail = await json(res);
      expect(Array.isArray(detail.issues)).toBe(true);
      expect(detail.issues).toHaveLength(1);
      expect(detail.issues[0]).toEqual({
        id: issue.id,
        title: 'Age inconsistency',
        severity: 'major',
      });
    });

    it('omits resolved issues from the entry detail response', async () => {
      const { hdrs } = await userWithToken('iss06b@test.com');
      const universe = await createUniverse(hdrs);
      const entry = await createEntry(universe.id, hdrs, { title: 'Location X' });

      const issue = await createIssue(universe.id, hdrs, {
        title: 'Already fixed',
        severity: 'minor',
        entryIds: [entry.id],
      });
      await patchIssue(universe.id, issue.id, hdrs, { resolved: true });

      const res = await req('GET', `/api/universes/${universe.id}/entries/${entry.id}`, { headers: hdrs });
      const detail = await json(res);
      expect(detail.issues).toEqual([]);
    });

    it('returns issues: [] for an entry with no associations', async () => {
      const { hdrs } = await userWithToken('iss06c@test.com');
      const universe = await createUniverse(hdrs);
      const entry = await createEntry(universe.id, hdrs, { title: 'Clean' });

      const res = await req('GET', `/api/universes/${universe.id}/entries/${entry.id}`, { headers: hdrs });
      const detail = await json(res);
      expect(detail.issues).toEqual([]);
    });

    it('only includes issues associated with this entry (not sibling entries)', async () => {
      const { hdrs } = await userWithToken('iss06d@test.com');
      const universe = await createUniverse(hdrs);
      const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
      const entryB = await createEntry(universe.id, hdrs, { title: 'B' });

      await createIssue(universe.id, hdrs, {
        title: 'Only on A',
        severity: 'moderate',
        entryIds: [entryA.id],
      });

      const resA = await req('GET', `/api/universes/${universe.id}/entries/${entryA.id}`, { headers: hdrs });
      const detailA = await json(resA);
      expect(detailA.issues).toHaveLength(1);

      const resB = await req('GET', `/api/universes/${universe.id}/entries/${entryB.id}`, { headers: hdrs });
      const detailB = await json(resB);
      expect(detailB.issues).toEqual([]);
    });
  });

  // ─── D-16: POST /entries — template last_used_at stamping ───────────────────

  describe('POST /universes/:universeId/entries — template last_used_at stamping (D-16)', () => {
    // Shared helpers scoped to this describe block
    async function insertTemplate(
      handle: TestDbHandle,
      userId: string,
      overrides: Partial<{
        name: string;
        entryType: string;
        lastUsedAt: Date | null;
      }> = {}
    ) {
      const [row] = await handle.db
        .insert(entryTemplates)
        .values({
          userId,
          name: overrides.name ?? 'Test Template',
          entryType: overrides.entryType ?? 'entity',
          summary: '',
          body: '',
          meta: [],
          lastUsedAt: overrides.lastUsedAt ?? null,
        })
        .returning();
      return row;
    }

    // Test 1 — stamp happens: templateId in body → last_used_at is set
    it('stamps last_used_at on the template when entry is created with templateId', async () => {
      const { user, hdrs } = await userWithToken('d16-stamp@test.com');
      const universe = await createUniverse(hdrs);

      // Insert template with lastUsedAt null
      const tmpl = await insertTemplate(handle, user.id);
      expect(tmpl.lastUsedAt).toBeNull();

      const res = await req('POST', `/api/universes/${universe.id}/entries`, {
        headers: hdrs,
        body: {
          title: 'Hero Character',
          entryType: 'entity',
          templateId: tmpl.id,
        },
      });
      expect(res.status).toBe(201);

      // Re-SELECT the template row and assert last_used_at was stamped
      const [updated] = await handle.db
        .select()
        .from(entryTemplates)
        .where(eq(entryTemplates.id, tmpl.id));
      expect(updated.lastUsedAt).not.toBeNull();
      expect(Date.now() - updated.lastUsedAt!.getTime()).toBeLessThan(5000);
    });

    // Test 2 — no templateId → no-op on existing templates
    it('does not modify any template last_used_at when entry is created without templateId', async () => {
      const { user, hdrs } = await userWithToken('d16-noop@test.com');
      const universe = await createUniverse(hdrs);

      // Pre-existing template with lastUsedAt null
      const tmpl = await insertTemplate(handle, user.id, { name: 'Existing Template' });

      const res = await req('POST', `/api/universes/${universe.id}/entries`, {
        headers: hdrs,
        body: {
          title: 'Blank Entry',
          entryType: 'entity',
          // no templateId
        },
      });
      expect(res.status).toBe(201);

      // Template should still have lastUsedAt null
      const [unchanged] = await handle.db
        .select()
        .from(entryTemplates)
        .where(eq(entryTemplates.id, tmpl.id));
      expect(unchanged.lastUsedAt).toBeNull();
    });

    // Test 3 — foreign templateId → entry created, but no stamp on other user's template
    it('creates the entry but does not stamp a template owned by another user (foreign templateId)', async () => {
      const userA = await userWithToken('d16-owner@test.com');
      const userB = await userWithToken('d16-thief@test.com');

      // User A creates a universe and a template
      const universeA = await createUniverse(userA.hdrs, 'World A');
      // User B creates their own universe to post an entry into
      const universeB = await createUniverse(userB.hdrs, 'World B');

      const tmplA = await insertTemplate(handle, userA.user.id, { name: 'Template A' });
      expect(tmplA.lastUsedAt).toBeNull();

      // User B POSTs an entry with user A's templateId
      const res = await req('POST', `/api/universes/${universeB.id}/entries`, {
        headers: userB.hdrs,
        body: {
          title: 'B Entry using A template',
          entryType: 'entity',
          templateId: tmplA.id,  // foreign templateId
        },
      });
      // Entry must still be created (best-effort — D-16)
      expect(res.status).toBe(201);

      // User A's template must NOT have been stamped (ownership WHERE returned 0 rows)
      const [row] = await handle.db
        .select()
        .from(entryTemplates)
        .where(eq(entryTemplates.id, tmplA.id));
      expect(row.lastUsedAt).toBeNull();
    });

    // Test 4 — deleted template between picker and create → no throw, entry still created
    it('creates the entry and does not throw when templateId references a deleted template', async () => {
      const { user, hdrs } = await userWithToken('d16-stale@test.com');
      const universe = await createUniverse(hdrs);

      // Insert then delete the template
      const tmpl = await insertTemplate(handle, user.id, { name: 'Stale Template' });
      await handle.db
        .delete(entryTemplates)
        .where(eq(entryTemplates.id, tmpl.id));

      // POST entry with the now-stale templateId — must return 201 (silent try/catch per D-16)
      const res = await req('POST', `/api/universes/${universe.id}/entries`, {
        headers: hdrs,
        body: {
          title: 'Entry with stale template',
          entryType: 'entity',
          templateId: tmpl.id,
        },
      });
      expect(res.status).toBe(201);
      const entry = await json(res);
      expect(entry.title).toBe('Entry with stale template');
    });

    // Test 5 — regression: existing non-template create flow still returns 201
    it('existing entry-create flow (no templateId) is unchanged', async () => {
      const { hdrs } = await userWithToken('d16-regression@test.com');
      const universe = await createUniverse(hdrs);

      const res = await req('POST', `/api/universes/${universe.id}/entries`, {
        headers: hdrs,
        body: {
          title: 'Regression Entry',
          entryType: 'concept',
          summary: 'still works',
          body: 'body text',
          tags: ['tag1'],
          meta: { key: 'value' },
          icon: '🔥',
        },
      });
      expect(res.status).toBe(201);
      const entry = await json(res);
      expect(entry.title).toBe('Regression Entry');
      expect(entry.summary).toBe('still works');
      expect(entry.tags).toEqual(['tag1']);
    });
  });

  // ─── DATA-03: WIP flag + three-state filter ──────────────────────────────────
  describe('wip flag + three-state filter (DATA-03)', () => {
    it('POST defaults wip to false when omitted; create/read round-trip wip=true', async () => {
      const { hdrs } = await userWithToken('wip-create@test.com');
      const universe = await createUniverse(hdrs);

      const defaulted = await createEntry(universe.id, hdrs, { title: 'No WIP field' });
      expect(defaulted.wip).toBe(false);

      const wipEntry = await createEntry(universe.id, hdrs, { title: 'Drafty', wip: true });
      expect(wipEntry.wip).toBe(true);

      // list surfaces wip
      const listRes = await req('GET', `/api/universes/${universe.id}/entries`, { headers: hdrs });
      const list = await json(listRes);
      const listed = list.find((e: any) => e.id === wipEntry.id);
      expect(listed.wip).toBe(true);

      // detail surfaces wip
      const detailRes = await req('GET', `/api/universes/${universe.id}/entries/${wipEntry.id}`, { headers: hdrs });
      const detail = await json(detailRes);
      expect(detail.wip).toBe(true);
    });

    it('PATCH sets wip; omitting wip on PATCH leaves the column unchanged (non-destructive)', async () => {
      const { hdrs } = await userWithToken('wip-patch@test.com');
      const universe = await createUniverse(hdrs);

      const created = await createEntry(universe.id, hdrs, { title: 'Patchable', wip: true });
      expect(created.wip).toBe(true);

      // PATCH without wip must NOT flip the stored value (T-36-03-04)
      const patchRes = await req('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, {
        headers: hdrs,
        body: { summary: 'unrelated change' },
      });
      const patched = await json(patchRes);
      expect(patched.wip).toBe(true);

      // PATCH with wip=false flips it
      const flipRes = await req('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, {
        headers: hdrs,
        body: { wip: false },
      });
      const flipped = await json(flipRes);
      expect(flipped.wip).toBe(false);
    });

    it('?wip=true / ?wip=false / absent return the correct subsets (three-state)', async () => {
      const { hdrs } = await userWithToken('wip-filter@test.com');
      const universe = await createUniverse(hdrs);

      const draft = await createEntry(universe.id, hdrs, { title: 'WIP One', wip: true });
      const done = await createEntry(universe.id, hdrs, { title: 'Finished One', wip: false });

      const allRes = await req('GET', `/api/universes/${universe.id}/entries`, { headers: hdrs });
      const all = await json(allRes);
      const allIds = all.map((e: any) => e.id);
      expect(allIds).toContain(draft.id);
      expect(allIds).toContain(done.id);

      const wipOnlyRes = await req('GET', `/api/universes/${universe.id}/entries?wip=true`, { headers: hdrs });
      const wipOnly = await json(wipOnlyRes);
      const wipIds = wipOnly.map((e: any) => e.id);
      expect(wipIds).toContain(draft.id);
      expect(wipIds).not.toContain(done.id);

      const finishedRes = await req('GET', `/api/universes/${universe.id}/entries?wip=false`, { headers: hdrs });
      const finished = await json(finishedRes);
      const finishedIds = finished.map((e: any) => e.id);
      expect(finishedIds).toContain(done.id);
      expect(finishedIds).not.toContain(draft.id);
    });
  });

  // ─── DATA-04: server-side field.* exact-match filters ────────────────────────
  describe('field.* exact-match meta filters (DATA-04)', () => {
    it('?field.Status=Complete returns only entries whose meta Status matches', async () => {
      const { hdrs } = await userWithToken('field-single@test.com');
      const universe = await createUniverse(hdrs);

      const complete = await createEntry(universe.id, hdrs, { title: 'Done Thing', meta: { Status: 'Complete' } });
      const inProgress = await createEntry(universe.id, hdrs, { title: 'WIP Thing', meta: { Status: 'InProgress' } });

      const res = await req('GET', `/api/universes/${universe.id}/entries?field.Status=Complete`, { headers: hdrs });
      const list = await json(res);
      const ids = list.map((e: any) => e.id);
      expect(ids).toContain(complete.id);
      expect(ids).not.toContain(inProgress.id);
    });

    it('multiple field.* params AND together', async () => {
      const { hdrs } = await userWithToken('field-multi@test.com');
      const universe = await createUniverse(hdrs);

      const match = await createEntry(universe.id, hdrs, {
        title: 'Both Match',
        meta: { Status: 'Complete', Importance: 'High' },
      });
      const partial = await createEntry(universe.id, hdrs, {
        title: 'Partial Match',
        meta: { Status: 'Complete', Importance: 'Low' },
      });

      const res = await req(
        'GET',
        `/api/universes/${universe.id}/entries?field.Status=Complete&field.Importance=High`,
        { headers: hdrs },
      );
      const list = await json(res);
      const ids = list.map((e: any) => e.id);
      expect(ids).toContain(match.id);
      expect(ids).not.toContain(partial.id);
    });

    it('field.* layers on top of ?type=', async () => {
      const { hdrs } = await userWithToken('field-layer@test.com');
      const universe = await createUniverse(hdrs);

      const wanted = await createEntry(universe.id, hdrs, {
        title: 'Concept Complete',
        entryType: 'concept',
        meta: { Status: 'Complete' },
      });
      // same meta, different type — excluded by ?type=concept
      const otherType = await createEntry(universe.id, hdrs, {
        title: 'Entity Complete',
        entryType: 'entity',
        meta: { Status: 'Complete' },
      });

      const res = await req(
        'GET',
        `/api/universes/${universe.id}/entries?type=concept&field.Status=Complete`,
        { headers: hdrs },
      );
      const list = await json(res);
      const ids = list.map((e: any) => e.id);
      expect(ids).toContain(wanted.id);
      expect(ids).not.toContain(otherType.id);
    });

    it('an injection-shaped field value is matched literally — normal no-match, no error/leak (T-36-03-01)', async () => {
      const { hdrs } = await userWithToken('field-injection@test.com');
      const universe = await createUniverse(hdrs);

      // Seed two real entries so a successful injection would over-return.
      const a = await createEntry(universe.id, hdrs, { title: 'Alpha', meta: { Status: 'Complete' } });
      const b = await createEntry(universe.id, hdrs, { title: 'Beta', meta: { Status: 'InProgress' } });

      const injection = `' OR '1'='1`;
      const res = await req(
        'GET',
        `/api/universes/${universe.id}/entries?field.Status=${encodeURIComponent(injection)}`,
        { headers: hdrs },
      );
      // Parameterized binding → the value is matched as a literal, so no row has Status === injection.
      expect(res.status).toBe(200);
      const list = await json(res);
      const ids = list.map((e: any) => e.id);
      expect(list).toHaveLength(0);
      expect(ids).not.toContain(a.id);
      expect(ids).not.toContain(b.id);
    });
  });
});
