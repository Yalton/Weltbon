import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb, db } from '../src/db/client.js';
import { graphPositions } from '../src/db/schema.js';

describe('graph-positions routes (GRAPH-05)', () => {
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
    const url = `http://localhost/api${path}`;
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

  async function createUniverse(hdrs: Record<string, string>, name = 'GraphPosWorld') {
    const res = await req('POST', '/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const defaults = { title: 'E', entryType: 'concept' };
    const res = await req('POST', `/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  async function countPositions(universeId: string): Promise<number> {
    const rows = await db().select().from(graphPositions).where(eq(graphPositions.universeId, universeId));
    return rows.length;
  }

  // GRAPH-05: POST pins a single entry
  it('POST /graph-positions upserts a single row', async () => {
    const { hdrs } = await userWithToken('gp1@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Pin me' });

    const res = await req('POST', `/universes/${universe.id}/graph-positions`, {
      headers: hdrs,
      body: { entryId: entry.id, x: 12.5, y: -3.25 },
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body).toMatchObject({ universeId: universe.id, entryId: entry.id, x: 12.5, y: -3.25 });

    expect(await countPositions(universe.id)).toBe(1);
  });

  // GRAPH-05: POST same entryId updates (composite PK on conflict)
  it('POST same entryId twice updates in place (no duplicate row)', async () => {
    const { hdrs } = await userWithToken('gp2@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Move me' });

    const r1 = await req('POST', `/universes/${universe.id}/graph-positions`, {
      headers: hdrs, body: { entryId: entry.id, x: 1, y: 1 },
    });
    expect(r1.status).toBe(201);

    const r2 = await req('POST', `/universes/${universe.id}/graph-positions`, {
      headers: hdrs, body: { entryId: entry.id, x: 99, y: -99 },
    });
    expect(r2.status).toBe(201);
    const updated = await json(r2);
    expect(updated.x).toBe(99);
    expect(updated.y).toBe(-99);

    expect(await countPositions(universe.id)).toBe(1);
  });

  // GRAPH-05: cross-universe entryId rejected
  it('POST rejects entryId from a different universe with 400', async () => {
    const { hdrs } = await userWithToken('gp-cross@test.com');
    const uniA = await createUniverse(hdrs, 'A');
    const uniB = await createUniverse(hdrs, 'B');
    const entryB = await createEntry(uniB.id, hdrs, { title: 'InB' });

    const res = await req('POST', `/universes/${uniA.id}/graph-positions`, {
      headers: hdrs,
      body: { entryId: entryB.id, x: 0, y: 0 },
    });
    expect(res.status).toBe(400);
    expect(await countPositions(uniA.id)).toBe(0);
  });

  // Zod validation: non-finite x
  it('POST rejects non-finite coordinates with 400', async () => {
    const { hdrs } = await userWithToken('gp-nan@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'E' });

    // JSON.stringify(Infinity) emits null -> Zod rejects as not a number.
    const res = await req('POST', `/universes/${universe.id}/graph-positions`, {
      headers: hdrs,
      // send raw string to bypass JSON.stringify dropping Infinity
      body: { entryId: entry.id, x: null, y: 0 },
    });
    expect(res.status).toBe(400);
  });

  // POST /bulk
  it('POST /bulk upserts multiple entries in a single transaction', async () => {
    const { hdrs } = await userWithToken('gp-bulk@test.com');
    const universe = await createUniverse(hdrs);
    const e1 = await createEntry(universe.id, hdrs, { title: 'E1' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'E2' });
    const e3 = await createEntry(universe.id, hdrs, { title: 'E3' });

    const res = await req('POST', `/universes/${universe.id}/graph-positions/bulk`, {
      headers: hdrs,
      body: [
        { entryId: e1.id, x: 1, y: 1 },
        { entryId: e2.id, x: 2, y: 2 },
        { entryId: e3.id, x: 3, y: 3 },
      ],
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.upserted).toBe(3);
    expect(await countPositions(universe.id)).toBe(3);

    // Bulk rerun updates in place
    const res2 = await req('POST', `/universes/${universe.id}/graph-positions/bulk`, {
      headers: hdrs,
      body: [
        { entryId: e1.id, x: 10, y: 10 },
        { entryId: e2.id, x: 20, y: 20 },
      ],
    });
    expect(res2.status).toBe(200);
    expect(await countPositions(universe.id)).toBe(3); // e3 still pinned, e1/e2 updated
    const e1Row = await db().select().from(graphPositions).where(and(eq(graphPositions.universeId, universe.id), eq(graphPositions.entryId, e1.id)));
    expect(e1Row[0].x).toBe(10);
    expect(e1Row[0].y).toBe(10);
  });

  // POST /bulk cross-universe rejection (atomic)
  it('POST /bulk rejects if any entryId belongs to another universe (atomic)', async () => {
    const { hdrs } = await userWithToken('gp-bulk-cross@test.com');
    const uniA = await createUniverse(hdrs, 'A');
    const uniB = await createUniverse(hdrs, 'B');
    const aE = await createEntry(uniA.id, hdrs, { title: 'A1' });
    const bE = await createEntry(uniB.id, hdrs, { title: 'B1' });

    const res = await req('POST', `/universes/${uniA.id}/graph-positions/bulk`, {
      headers: hdrs,
      body: [
        { entryId: aE.id, x: 1, y: 1 },
        { entryId: bE.id, x: 2, y: 2 },
      ],
    });
    expect(res.status).toBe(400);
    // Atomicity: neither should be saved
    expect(await countPositions(uniA.id)).toBe(0);
    expect(await countPositions(uniB.id)).toBe(0);
  });

  // DELETE / clears all
  it('DELETE /graph-positions clears all pins for the universe (reset-layout)', async () => {
    const { hdrs } = await userWithToken('gp-reset@test.com');
    const universe = await createUniverse(hdrs);
    const otherUniverse = await createUniverse(hdrs, 'Other');
    const e1 = await createEntry(universe.id, hdrs, { title: 'E1' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'E2' });
    const e3 = await createEntry(otherUniverse.id, hdrs, { title: 'Other E' });

    await db().insert(graphPositions).values({ universeId: universe.id, entryId: e1.id, x: 1, y: 1 });
    await db().insert(graphPositions).values({ universeId: universe.id, entryId: e2.id, x: 2, y: 2 });
    await db().insert(graphPositions).values({ universeId: otherUniverse.id, entryId: e3.id, x: 3, y: 3 });

    const res = await req('DELETE', `/universes/${universe.id}/graph-positions`, { headers: hdrs });
    expect(res.status).toBe(204);

    expect(await countPositions(universe.id)).toBe(0);
    // Other universe's pins are untouched
    expect(await countPositions(otherUniverse.id)).toBe(1);
  });

  // DELETE /:entryId clears single
  it('DELETE /graph-positions/:entryId clears only that pin', async () => {
    const { hdrs } = await userWithToken('gp-single@test.com');
    const universe = await createUniverse(hdrs);
    const e1 = await createEntry(universe.id, hdrs, { title: 'E1' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'E2' });

    await db().insert(graphPositions).values({ universeId: universe.id, entryId: e1.id, x: 1, y: 1 });
    await db().insert(graphPositions).values({ universeId: universe.id, entryId: e2.id, x: 2, y: 2 });

    const res = await req('DELETE', `/universes/${universe.id}/graph-positions/${e1.id}`, { headers: hdrs });
    expect(res.status).toBe(204);

    expect(await countPositions(universe.id)).toBe(1);
    const remaining = await db().select().from(graphPositions).where(eq(graphPositions.universeId, universe.id));
    expect(remaining[0].entryId).toBe(e2.id);
  });

  // Cross-tenant 403
  it('cross-tenant access returns 403 on all endpoints', async () => {
    const owner = await userWithToken('gp-owner@test.com');
    const stranger = await userWithToken('gp-stranger@test.com');
    const universe = await createUniverse(owner.hdrs);
    const entry = await createEntry(universe.id, owner.hdrs, { title: 'E' });

    const postRes = await req('POST', `/universes/${universe.id}/graph-positions`, {
      headers: stranger.hdrs, body: { entryId: entry.id, x: 1, y: 1 },
    });
    expect(postRes.status).toBe(403);

    const bulkRes = await req('POST', `/universes/${universe.id}/graph-positions/bulk`, {
      headers: stranger.hdrs, body: [{ entryId: entry.id, x: 1, y: 1 }],
    });
    expect(bulkRes.status).toBe(403);

    const delAll = await req('DELETE', `/universes/${universe.id}/graph-positions`, { headers: stranger.hdrs });
    expect(delAll.status).toBe(403);

    const delOne = await req('DELETE', `/universes/${universe.id}/graph-positions/${entry.id}`, { headers: stranger.hdrs });
    expect(delOne.status).toBe(403);
  });
});
