import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb, db } from '../src/db/client.js';
import { graphPositions, links } from '../src/db/schema.js';

describe('graph-data route (GRAPH-01)', () => {
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

  async function createUniverse(hdrs: Record<string, string>, name = 'GraphWorld') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const defaults = { title: 'E', entryType: 'concept' };
    const res = await req('POST', `/api/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  async function insertLink(
    universeId: string,
    sourceEntryId: string,
    targetEntryId: string,
    label: string | null,
    direction: 'directed' | 'undirected' = 'directed',
    linkType: string | null = null,
  ) {
    const [created] = await db()
      .insert(links)
      .values({ universeId, sourceEntryId, targetEntryId, label, direction, linkType })
      .returning();
    return created;
  }

  // GRAPH-01: returns { nodes, edges, positions } in a single endpoint
  it('GET /universes/:uid/graph-data returns nodes, edges, and empty positions', async () => {
    const { hdrs } = await userWithToken('g1@test.com');
    const universe = await createUniverse(hdrs);
    const e1 = await createEntry(universe.id, hdrs, { title: 'Alpha', entryType: 'concept', summary: 'sa', icon: '⭐' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'Beta', entryType: 'entity' });
    const e3 = await createEntry(universe.id, hdrs, { title: 'Gamma', entryType: 'location' });
    const l1 = await insertLink(universe.id, e1.id, e2.id, 'relates', 'directed');
    const l2 = await insertLink(universe.id, e2.id, e3.id, 'in', 'undirected');

    const res = await req('GET', `/api/universes/${universe.id}/graph-data`, { headers: hdrs });
    expect(res.status).toBe(200);
    const data = await json(res);

    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
    expect(Array.isArray(data.positions)).toBe(true);

    expect(data.nodes).toHaveLength(3);
    const titles = data.nodes.map((n: { title: string }) => n.title).sort();
    expect(titles).toEqual(['Alpha', 'Beta', 'Gamma']);
    // Node shape: id, title, entryType, summary, icon
    const alphaNode = data.nodes.find((n: { title: string }) => n.title === 'Alpha');
    expect(alphaNode).toMatchObject({ id: e1.id, title: 'Alpha', entryType: 'concept', summary: 'sa', icon: '⭐' });

    expect(data.edges).toHaveLength(2);
    // Edge shape: id, source, target, label, linkType, direction — NO bidirectional
    const edgeL1 = data.edges.find((e: { id: string }) => e.id === l1.id);
    expect(edgeL1).toMatchObject({ id: l1.id, source: e1.id, target: e2.id, label: 'relates', direction: 'directed' });
    expect(edgeL1).not.toHaveProperty('bidirectional');
    const edgeL2 = data.edges.find((e: { id: string }) => e.id === l2.id);
    expect(edgeL2).toMatchObject({ source: e2.id, target: e3.id, direction: 'undirected' });
    expect(edgeL2).not.toHaveProperty('bidirectional');

    expect(data.positions).toEqual([]);
  });

  // Phase 28: typed link surfaces in graph-data with correct linkType + direction
  it('GET graph-data: typed link has linkType + direction, no bidirectional', async () => {
    const { hdrs } = await userWithToken('g-typed@test.com');
    const universe = await createUniverse(hdrs);
    const e1 = await createEntry(universe.id, hdrs, { title: 'Parent' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'Child' });
    const tl = await insertLink(universe.id, e1.id, e2.id, null, 'directed', 'parent_of');

    const res = await req('GET', `/api/universes/${universe.id}/graph-data`, { headers: hdrs });
    expect(res.status).toBe(200);
    const data = await json(res);

    const edge = data.edges.find((e: { id: string }) => e.id === tl.id);
    expect(edge).toBeDefined();
    expect(edge.linkType).toBe('parent_of');
    expect(edge.direction).toBe('directed');
    expect(edge.label).toBeNull();
    expect(edge).not.toHaveProperty('bidirectional');
  });

  it('returns saved positions when graph_positions rows exist', async () => {
    const { hdrs } = await userWithToken('g2@test.com');
    const universe = await createUniverse(hdrs);
    const e1 = await createEntry(universe.id, hdrs, { title: 'Pinned' });

    await db().insert(graphPositions).values({ universeId: universe.id, entryId: e1.id, x: 42.5, y: -17.25 });

    const res = await req('GET', `/api/universes/${universe.id}/graph-data`, { headers: hdrs });
    expect(res.status).toBe(200);
    const data = await json(res);

    expect(data.positions).toHaveLength(1);
    expect(data.positions[0]).toMatchObject({ entryId: e1.id, x: 42.5, y: -17.25 });
  });

  it('returns empty arrays for a fresh universe with no entries', async () => {
    const { hdrs } = await userWithToken('g3@test.com');
    const universe = await createUniverse(hdrs);
    const res = await req('GET', `/api/universes/${universe.id}/graph-data`, { headers: hdrs });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.nodes).toEqual([]);
    expect(data.edges).toEqual([]);
    expect(data.positions).toEqual([]);
  });

  it('cross-tenant access returns 403', async () => {
    const owner = await userWithToken('graph-owner@test.com');
    const stranger = await userWithToken('graph-stranger@test.com');
    const universe = await createUniverse(owner.hdrs);

    const res = await req('GET', `/api/universes/${universe.id}/graph-data`, { headers: stranger.hdrs });
    expect(res.status).toBe(403);
  });

  it('non-existent universe returns 404', async () => {
    const { hdrs } = await userWithToken('graph-404@test.com');
    const res = await req('GET', `/api/universes/00000000-0000-0000-0000-000000000000/graph-data`, { headers: hdrs });
    expect(res.status).toBe(404);
  });

  it('scopes nodes, edges, and positions strictly to the requested universe', async () => {
    const { hdrs } = await userWithToken('g-scope@test.com');
    const uniA = await createUniverse(hdrs, 'A');
    const uniB = await createUniverse(hdrs, 'B');
    const aE1 = await createEntry(uniA.id, hdrs, { title: 'A1' });
    const aE2 = await createEntry(uniA.id, hdrs, { title: 'A2' });
    const bE1 = await createEntry(uniB.id, hdrs, { title: 'B1' });
    await insertLink(uniA.id, aE1.id, aE2.id, 'a-link');
    await db().insert(graphPositions).values({ universeId: uniB.id, entryId: bE1.id, x: 1, y: 2 });

    const resA = await req('GET', `/api/universes/${uniA.id}/graph-data`, { headers: hdrs });
    const dataA = await json(resA);
    expect(dataA.nodes).toHaveLength(2);
    expect(dataA.edges).toHaveLength(1);
    expect(dataA.positions).toHaveLength(0);

    const resB = await req('GET', `/api/universes/${uniB.id}/graph-data`, { headers: hdrs });
    const dataB = await json(resB);
    expect(dataB.nodes).toHaveLength(1);
    expect(dataB.edges).toHaveLength(0);
    expect(dataB.positions).toHaveLength(1);
  });
});
