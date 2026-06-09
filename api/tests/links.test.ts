import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('link routes (LINK-01..06)', () => {
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

  async function json(res: Response): Promise<any> {
    return res.json();
  }

  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const defaults = { title: 'Test Entry', entryType: 'concept' };
    const res = await req('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  // LINK-01: create typed directed link
  it('POST /universes/:uid/links with linkType+direction creates typed link', async () => {
    const { hdrs } = await userWithToken('a@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B' });

    const res = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        linkType: 'member_of',
        direction: 'directed',
      },
    });

    expect(res.status).toBe(201);
    const link = await json(res);
    expect(link.id).toBeTruthy();
    expect(link.universeId).toBe(universe.id);
    expect(link.sourceEntryId).toBe(entryA.id);
    expect(link.targetEntryId).toBe(entryB.id);
    expect(link.linkType).toBe('member_of');
    expect(link.direction).toBe('directed');
    expect(link.label).toBeNull();
    expect(link.createdAt).toBeTruthy();
  });

  // LINK-02: create untyped link (no linkType, no label)
  it('POST /universes/:uid/links with only sourceEntryId+targetEntryId creates untyped link', async () => {
    const { hdrs } = await userWithToken('b@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B' });

    const res = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
      },
    });

    expect(res.status).toBe(201);
    const link = await json(res);
    expect(link.linkType).toBeNull();
    expect(link.direction).toBe('directed'); // default
    expect(link.label).toBeNull();
  });

  // direction validation: rejects invalid direction
  it('POST /universes/:uid/links with invalid direction returns 400', async () => {
    const { hdrs } = await userWithToken('b2@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });

    const res = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        direction: 'lateral', // invalid
      },
    });

    expect(res.status).toBe(400);
  });

  // linkType max 100 chars
  it('POST /universes/:uid/links with linkType > 100 chars returns 400', async () => {
    const { hdrs } = await userWithToken('b3@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });

    const res = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        linkType: 'x'.repeat(101),
      },
    });

    expect(res.status).toBe(400);
  });

  // PATCH link — update linkType and direction
  it('PATCH /universes/:uid/links/:id updates linkType and direction preserving id+createdAt', async () => {
    const { hdrs } = await userWithToken('patch1@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });

    const createRes = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        linkType: 'related_to',
        direction: 'directed',
      },
    });
    const created = await json(createRes);

    const patchRes = await req('PATCH', `/api/universes/${universe.id}/links/${created.id}`, {
      headers: hdrs,
      body: { linkType: 'ally_of', direction: 'undirected' },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.linkType).toBe('ally_of');
    expect(updated.direction).toBe('undirected');
  });

  // PATCH link — partial patch (only label, direction unchanged)
  it('PATCH /universes/:uid/links/:id with only label leaves direction unchanged', async () => {
    const { hdrs } = await userWithToken('patch2@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });

    const createRes = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        direction: 'undirected',
      },
    });
    const created = await json(createRes);
    expect(created.direction).toBe('undirected');

    const patchRes = await req('PATCH', `/api/universes/${universe.id}/links/${created.id}`, {
      headers: hdrs,
      body: { label: 'note' },
    });

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.direction).toBe('undirected'); // unchanged
    expect(updated.label).toBe('note');
  });

  // PATCH link in another user's universe → 404
  it('PATCH /universes/:uid/links/:id in another user universe returns 404', async () => {
    const owner = await userWithToken('patch-owner@test.com');
    const stranger = await userWithToken('patch-stranger@test.com');
    const universe = await createUniverse(owner.hdrs);
    const entryA = await createEntry(universe.id, owner.hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, owner.hdrs, { title: 'B' });

    const createRes = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: owner.hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryB.id },
    });
    const link = await json(createRes);

    // Stranger tries to patch the link using their own fake universe id
    const strangerUniverse = await createUniverse(stranger.hdrs, 'Stranger World');
    const patchRes = await req('PATCH', `/api/universes/${strangerUniverse.id}/links/${link.id}`, {
      headers: stranger.hdrs,
      body: { label: 'hack' },
    });
    expect(patchRes.status).toBe(404);
  });

  // GET /link-types returns distinct non-null types with counts
  it('GET /universes/:uid/link-types returns { linkType, count } for non-null types', async () => {
    const { hdrs } = await userWithToken('lt1@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });
    const entryC = await createEntry(universe.id, hdrs, { title: 'C' });

    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryB.id, linkType: 'ally_of' },
    });
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryB.id, targetEntryId: entryC.id, linkType: 'ally_of' },
    });
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryC.id, linkType: 'enemy_of' },
    });
    // Untyped link — should NOT appear in link-types
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryC.id, targetEntryId: entryA.id },
    });

    const res = await req('GET', `/api/universes/${universe.id}/link-types`, { headers: hdrs });
    expect(res.status).toBe(200);
    const rows = await json(res);
    // ally_of x2, enemy_of x1
    expect(rows).toEqual([
      { linkType: 'ally_of', count: 2 },
      { linkType: 'enemy_of', count: 1 },
    ]);
  });

  // GET /link-types returns [] for no typed links
  it('GET /universes/:uid/link-types returns [] when no typed links exist', async () => {
    const { hdrs } = await userWithToken('lt-empty@test.com');
    const universe = await createUniverse(hdrs);
    const res = await req('GET', `/api/universes/${universe.id}/link-types`, { headers: hdrs });
    expect(res.status).toBe(200);
    const rows = await json(res);
    expect(rows).toEqual([]);
  });

  // Self-link prevention
  it('POST /universes/:uid/links rejects self-link with 400', async () => {
    const { hdrs } = await userWithToken('c@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Self Referrer' });

    const res = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entry.id,
        targetEntryId: entry.id,
      },
    });

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/itself/i);
  });

  // Cross-universe link prevention
  it('POST /universes/:uid/links rejects link to entry in different universe', async () => {
    const { hdrs } = await userWithToken('d@test.com');
    const universeA = await createUniverse(hdrs, 'World A');
    const universeB = await createUniverse(hdrs, 'World B');
    const entryA = await createEntry(universeA.id, hdrs, { title: 'Entry in A' });
    const entryB = await createEntry(universeB.id, hdrs, { title: 'Entry in B' });

    const res = await req('POST', `/api/universes/${universeA.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
      },
    });

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toMatch(/not found/i);
  });

  // LINK-03: delete link
  it('DELETE /universes/:uid/links/:id removes the link', async () => {
    const { hdrs } = await userWithToken('e@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Entry A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Entry B' });

    const createRes = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        label: 'contains',
      },
    });
    const link = await json(createRes);

    const delRes = await req('DELETE', `/api/universes/${universe.id}/links/${link.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    // Verify it's gone from list
    const listRes = await req('GET', `/api/universes/${universe.id}/links`, { headers: hdrs });
    const list = await json(listRes);
    expect(list.find((l: any) => l.id === link.id)).toBeUndefined();
  });

  // Delete nonexistent link returns 404
  it('DELETE /universes/:uid/links/:id returns 404 for nonexistent link', async () => {
    const { hdrs } = await userWithToken('f@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('DELETE', `/api/universes/${universe.id}/links/00000000-0000-0000-0000-000000000000`, { headers: hdrs });
    expect(res.status).toBe(404);
  });

  // List links
  it('GET /universes/:uid/links returns all links for the universe', async () => {
    const { hdrs } = await userWithToken('g@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });
    const entryC = await createEntry(universe.id, hdrs, { title: 'C' });

    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryB.id, label: 'link1' },
    });
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryB.id, targetEntryId: entryC.id, label: 'link2' },
    });

    const res = await req('GET', `/api/universes/${universe.id}/links`, { headers: hdrs });
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(list).toHaveLength(2);
  });

  // POL-03 backend: GET /relations returns [{label, count}] sorted by count desc
  it('GET /universes/:uid/relations returns [{label,count}] sorted by count desc', async () => {
    const { hdrs } = await userWithToken('h@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });
    const entryC = await createEntry(universe.id, hdrs, { title: 'C' });

    // 'created by' x2, 'located in' x1
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryB.id, label: 'created by' },
    });
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryB.id, targetEntryId: entryC.id, label: 'located in' },
    });
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryC.id, label: 'created by' },
    });

    const res = await req('GET', `/api/universes/${universe.id}/relations`, { headers: hdrs });
    expect(res.status).toBe(200);
    const rows = await json(res);
    expect(rows).toEqual([
      { label: 'created by', count: 2 },
      { label: 'located in', count: 1 },
    ]);
  });

  it('GET /relations sorts equal counts by label ASC for deterministic tiebreak', async () => {
    const { hdrs } = await userWithToken('h-tiebreak@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });
    const entryC = await createEntry(universe.id, hdrs, { title: 'C' });

    // Each label used exactly once -> tiebreak by label ASC
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryB.id, label: 'zeta' },
    });
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryB.id, targetEntryId: entryC.id, label: 'alpha' },
    });
    await req('POST', `/api/universes/${universe.id}/links`, {
      headers: hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryC.id, label: 'mu' },
    });

    const res = await req('GET', `/api/universes/${universe.id}/relations`, { headers: hdrs });
    const rows = await json(res);
    expect(rows.map((r: { label: string }) => r.label)).toEqual(['alpha', 'mu', 'zeta']);
    expect(rows.every((r: { count: number }) => r.count === 1)).toBe(true);
  });

  it('GET /relations returns [] for a universe with no links', async () => {
    const { hdrs } = await userWithToken('h-empty@test.com');
    const universe = await createUniverse(hdrs);
    const res = await req('GET', `/api/universes/${universe.id}/relations`, { headers: hdrs });
    expect(res.status).toBe(200);
    const rows = await json(res);
    expect(rows).toEqual([]);
  });

  // Cross-tenant access returns 403
  it('cross-tenant access returns 403', async () => {
    const owner = await userWithToken('owner@test.com');
    const stranger = await userWithToken('stranger@test.com');
    const universe = await createUniverse(owner.hdrs);
    const entryA = await createEntry(universe.id, owner.hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, owner.hdrs, { title: 'B' });

    // Stranger tries to create a link
    const createRes = await req('POST', `/api/universes/${universe.id}/links`, {
      headers: stranger.hdrs,
      body: { sourceEntryId: entryA.id, targetEntryId: entryB.id },
    });
    expect(createRes.status).toBe(403);

    // Stranger tries to list links
    const listRes = await req('GET', `/api/universes/${universe.id}/links`, { headers: stranger.hdrs });
    expect(listRes.status).toBe(403);

    // Stranger tries to get relations
    const relRes = await req('GET', `/api/universes/${universe.id}/relations`, { headers: stranger.hdrs });
    expect(relRes.status).toBe(403);
  });
});
