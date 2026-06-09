import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('issues routes (ISS-01..05)', () => {
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

  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const defaults = { title: 'Test Entry', entryType: 'concept' };
    const res = await req('POST', `/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  // ISS-01: create issue with required + default fields
  it('POST /universes/:uid/issues creates issue with title + severity', async () => {
    const { hdrs } = await userWithToken('iss1@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Contradiction in history', severity: 'major' },
    });

    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.title).toBe('Contradiction in history');
    expect(body.severity).toBe('major');
    expect(body.resolved).toBe(false);
    expect(body.description).toBe('');
    expect(Array.isArray(body.entryIds)).toBe(true);
    expect(body.entryIds).toEqual([]);
    expect(typeof body.id).toBe('string');
    expect(body.createdAt).toBeTruthy();
    expect(body.updatedAt).toBeTruthy();
  });

  // ISS-01: rejects invalid severity
  it('POST rejects invalid severity with 400', async () => {
    const { hdrs } = await userWithToken('iss-sev@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Bad', severity: 'bogus' },
    });
    expect(res.status).toBe(400);
  });

  // ISS-02: create with entry associations
  it('POST creates issue_entries rows for each entryId', async () => {
    const { hdrs } = await userWithToken('iss2@test.com');
    const universe = await createUniverse(hdrs);
    const e1 = await createEntry(universe.id, hdrs, { title: 'E1' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'E2' });

    const res = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: {
        title: 'Double mention',
        severity: 'minor',
        entryIds: [e1.id, e2.id],
      },
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.entryIds.sort()).toEqual([e1.id, e2.id].sort());

    // GET /:id confirms entries array
    const getRes = await req('GET', `/universes/${universe.id}/issues/${body.id}`, { headers: hdrs });
    expect(getRes.status).toBe(200);
    const got = await json(getRes);
    expect(got.entries).toHaveLength(2);
    const ids = got.entries.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual([e1.id, e2.id].sort());
    expect(got.entries[0]).toHaveProperty('title');
    expect(got.entries[0]).toHaveProperty('icon');
  });

  // ISS-02: rejects entryIds from another universe
  it('POST rejects entryIds that belong to another universe with 400', async () => {
    const { hdrs } = await userWithToken('iss-cross@test.com');
    const uniA = await createUniverse(hdrs, 'A');
    const uniB = await createUniverse(hdrs, 'B');
    const entryB = await createEntry(uniB.id, hdrs, { title: 'InB' });

    const res = await req('POST', `/universes/${uniA.id}/issues`, {
      headers: hdrs,
      body: { title: 'X', severity: 'minor', entryIds: [entryB.id] },
    });
    expect(res.status).toBe(400);
  });

  // ISS-05: list filters by severity and resolved
  it('GET /issues supports ?severity and ?resolved filters', async () => {
    const { hdrs } = await userWithToken('iss5@test.com');
    const universe = await createUniverse(hdrs);

    const mk = async (body: Record<string, unknown>) => {
      const r = await req('POST', `/universes/${universe.id}/issues`, { headers: hdrs, body });
      return json(r);
    };
    const i1 = await mk({ title: 'Crit Open', severity: 'critical' });
    await mk({ title: 'Minor Open', severity: 'minor' });
    const i3 = await mk({ title: 'Major Open', severity: 'major' });

    // Resolve one
    await req('PATCH', `/universes/${universe.id}/issues/${i3.id}`, { headers: hdrs, body: { resolved: true } });

    // All
    const allRes = await req('GET', `/universes/${universe.id}/issues`, { headers: hdrs });
    const all = await json(allRes);
    expect(all).toHaveLength(3);

    // ?severity=critical
    const critRes = await req('GET', `/universes/${universe.id}/issues?severity=critical`, { headers: hdrs });
    const crit = await json(critRes);
    expect(crit).toHaveLength(1);
    expect(crit[0].id).toBe(i1.id);

    // ?resolved=false
    const openRes = await req('GET', `/universes/${universe.id}/issues?resolved=false`, { headers: hdrs });
    const open = await json(openRes);
    expect(open).toHaveLength(2);

    // ?resolved=true
    const resRes = await req('GET', `/universes/${universe.id}/issues?resolved=true`, { headers: hdrs });
    const resolved = await json(resRes);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe(i3.id);

    // Combined
    const comboRes = await req('GET', `/universes/${universe.id}/issues?severity=major&resolved=true`, { headers: hdrs });
    const combo = await json(comboRes);
    expect(combo).toHaveLength(1);
    expect(combo[0].id).toBe(i3.id);
  });

  // ISS-05: list includes associated entries
  it('GET /issues returns each issue with its entries array', async () => {
    const { hdrs } = await userWithToken('iss-list@test.com');
    const universe = await createUniverse(hdrs);
    const e1 = await createEntry(universe.id, hdrs, { title: 'E1', icon: '💡' });

    const postRes = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Issue X', severity: 'minor', entryIds: [e1.id] },
    });
    await json(postRes);

    const listRes = await req('GET', `/universes/${universe.id}/issues`, { headers: hdrs });
    const list = await json(listRes);
    expect(list).toHaveLength(1);
    expect(list[0].entries).toHaveLength(1);
    expect(list[0].entries[0].id).toBe(e1.id);
    expect(list[0].entries[0].title).toBe('E1');
    expect(list[0].entries[0].icon).toBe('💡');
  });

  // ISS-03: mark resolved
  it('PATCH marks issue resolved', async () => {
    const { hdrs } = await userWithToken('iss3@test.com');
    const universe = await createUniverse(hdrs);
    const createRes = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'To Resolve', severity: 'minor' },
    });
    const created = await json(createRes);
    expect(created.resolved).toBe(false);

    const patchRes = await req('PATCH', `/universes/${universe.id}/issues/${created.id}`, {
      headers: hdrs,
      body: { resolved: true },
    });
    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.resolved).toBe(true);
  });

  // ISS-04: edit title/description/severity
  it('PATCH updates title, description, severity', async () => {
    const { hdrs } = await userWithToken('iss4a@test.com');
    const universe = await createUniverse(hdrs);
    const createRes = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Original', severity: 'minor' },
    });
    const created = await json(createRes);

    const patchRes = await req('PATCH', `/universes/${universe.id}/issues/${created.id}`, {
      headers: hdrs,
      body: { title: 'New Title', description: 'More context', severity: 'critical' },
    });
    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.title).toBe('New Title');
    expect(updated.description).toBe('More context');
    expect(updated.severity).toBe('critical');
  });

  // ISS-04: delete removes issue
  it('DELETE removes issue', async () => {
    const { hdrs } = await userWithToken('iss4b@test.com');
    const universe = await createUniverse(hdrs);
    const createRes = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Doomed', severity: 'minor' },
    });
    const created = await json(createRes);

    const delRes = await req('DELETE', `/universes/${universe.id}/issues/${created.id}`, { headers: hdrs });
    expect(delRes.status).toBe(204);

    const getRes = await req('GET', `/universes/${universe.id}/issues/${created.id}`, { headers: hdrs });
    expect(getRes.status).toBe(404);
  });

  // ISS-02: PATCH replaces associations when entryIds passed
  it('PATCH with entryIds replaces associations', async () => {
    const { hdrs } = await userWithToken('iss-reassoc@test.com');
    const universe = await createUniverse(hdrs);
    const e1 = await createEntry(universe.id, hdrs, { title: 'E1' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'E2' });
    const e3 = await createEntry(universe.id, hdrs, { title: 'E3' });

    const createRes = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Reassoc', severity: 'minor', entryIds: [e1.id, e2.id] },
    });
    const created = await json(createRes);

    // Replace with [e3]
    const patchRes = await req('PATCH', `/universes/${universe.id}/issues/${created.id}`, {
      headers: hdrs,
      body: { entryIds: [e3.id] },
    });
    expect(patchRes.status).toBe(200);

    const getRes = await req('GET', `/universes/${universe.id}/issues/${created.id}`, { headers: hdrs });
    const got = await json(getRes);
    expect(got.entries).toHaveLength(1);
    expect(got.entries[0].id).toBe(e3.id);

    // Replace with []
    const patchRes2 = await req('PATCH', `/universes/${universe.id}/issues/${created.id}`, {
      headers: hdrs,
      body: { entryIds: [] },
    });
    expect(patchRes2.status).toBe(200);
    const getRes2 = await req('GET', `/universes/${universe.id}/issues/${created.id}`, { headers: hdrs });
    const got2 = await json(getRes2);
    expect(got2.entries).toHaveLength(0);
  });

  // ISS-02: PATCH rejects entryIds from another universe
  it('PATCH rejects entryIds from another universe with 400', async () => {
    const { hdrs } = await userWithToken('iss-patch-cross@test.com');
    const uniA = await createUniverse(hdrs, 'A');
    const uniB = await createUniverse(hdrs, 'B');
    const entryB = await createEntry(uniB.id, hdrs, { title: 'InB' });

    const createRes = await req('POST', `/universes/${uniA.id}/issues`, {
      headers: hdrs,
      body: { title: 'I', severity: 'minor' },
    });
    const created = await json(createRes);

    const patchRes = await req('PATCH', `/universes/${uniA.id}/issues/${created.id}`, {
      headers: hdrs,
      body: { entryIds: [entryB.id] },
    });
    expect(patchRes.status).toBe(400);
  });

  // Cross-tenant 403 on every endpoint
  it('cross-tenant access returns 403 on all endpoints', async () => {
    const a = await userWithToken('owner-iss@test.com');
    const b = await userWithToken('stranger-iss@test.com');
    const universe = await createUniverse(a.hdrs);

    const createRes = await req('POST', `/universes/${universe.id}/issues`, {
      headers: a.hdrs,
      body: { title: 'Private', severity: 'minor' },
    });
    const created = await json(createRes);

    const postRes = await req('POST', `/universes/${universe.id}/issues`, {
      headers: b.hdrs,
      body: { title: 'Evil', severity: 'minor' },
    });
    expect(postRes.status).toBe(403);

    const listRes = await req('GET', `/universes/${universe.id}/issues`, { headers: b.hdrs });
    expect(listRes.status).toBe(403);

    const getRes = await req('GET', `/universes/${universe.id}/issues/${created.id}`, { headers: b.hdrs });
    expect(getRes.status).toBe(403);

    const patchRes = await req('PATCH', `/universes/${universe.id}/issues/${created.id}`, {
      headers: b.hdrs,
      body: { resolved: true },
    });
    expect(patchRes.status).toBe(403);

    const delRes = await req('DELETE', `/universes/${universe.id}/issues/${created.id}`, { headers: b.hdrs });
    expect(delRes.status).toBe(403);
  });

  // GET /:id 404 for nonexistent
  it('GET /:id returns 404 for nonexistent issue', async () => {
    const { hdrs } = await userWithToken('iss-404@test.com');
    const universe = await createUniverse(hdrs);
    const res = await req('GET', `/universes/${universe.id}/issues/00000000-0000-0000-0000-000000000000`, { headers: hdrs });
    expect(res.status).toBe(404);
  });

  // FIX-01 (D-14): issues_universe_gap_key_unique was NULLS NOT DISTINCT (wrong —
  // NULLs were treated as equal, blocking a 2nd human issue per universe). Migration
  // 0013 recreates the index without that clause (NULLS DISTINCT = Postgres default),
  // allowing unlimited manual (gap_key=NULL) issues per universe.
  it('FIX-01: allows >= 2 manual (gap_key=null) issues in the same universe', async () => {
    const { hdrs } = await userWithToken('fix01@test.com');
    const universe = await createUniverse(hdrs);

    // First manual issue — gap_key=NULL because entryIds is optional, no gapKey in createSchema
    const r1 = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Issue 1', severity: 'minor' },
    });
    expect(r1.status).toBe(201);
    const body1 = await r1.json();
    expect(body1.title).toBe('Issue 1');

    // Second manual issue in the SAME universe — previously failed with unique violation
    // before FIX-01 because NULLS NOT DISTINCT treated (universe_id, NULL) as a duplicate.
    const r2 = await req('POST', `/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Issue 2', severity: 'major' },
    });
    expect(r2.status).toBe(201); // This was 500 before FIX-01
    const body2 = await r2.json();
    expect(body2.title).toBe('Issue 2');

    // Confirm both rows exist in the universe
    const listRes = await req('GET', `/universes/${universe.id}/issues`, { headers: hdrs });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list).toHaveLength(2);
    const titles = list.map((i: { title: string }) => i.title).sort();
    expect(titles).toEqual(['Issue 1', 'Issue 2']);
  });
});
