import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { universes } from '../src/db/schema.js';
import { setTestDb } from '../src/db/client.js';

describe('universe routes (UNIV-01..06)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    // Redirect the app-level db client to the dedicated schema-pinned pool
    // from createTestDb() so route handlers write into the test schema.
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

  /** Helper to make requests via Hono's built-in test API */
  async function req(method: string, path: string, opts?: { headers?: Record<string, string>; body?: unknown }) {
    const url = `http://localhost${path}`;
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await app.request(url, init);
    return res;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  // Unauth path
  it('GET /universes without Authorization returns 401', async () => {
    const res = await req('GET', '/universes');
    expect(res.status).toBe(401);
  });

  // UNIV-01: create
  it('POST /universes creates universe owned by caller with default entryTypes', async () => {
    const { user, hdrs } = await userWithToken('a@test.com');
    const res = await req('POST', '/universes', { headers: hdrs, body: { name: 'Post-Sundering' } });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.name).toBe('Post-Sundering');
    expect(body.description).toBe('');
    expect(body.userId).toBe(user.id);
    expect(body.entryTypes).toEqual([
      'concept', 'entity', 'location', 'event', 'faction',
      'artifact', 'species', 'culture', 'thread',
    ]);
    expect(typeof body.id).toBe('string');
  });

  it('POST /universes rejects empty name with 400', async () => {
    const { hdrs } = await userWithToken('a2@test.com');
    const res = await req('POST', '/universes', { headers: hdrs, body: { name: '' } });
    expect(res.status).toBe(400);
  });

  // UNIV-02: list is scoped
  it("GET /universes returns only caller's universes (cross-tenant invisible)", async () => {
    const a = await userWithToken('a3@test.com');
    const b = await userWithToken('b3@test.com');
    await req('POST', '/universes', { headers: a.hdrs, body: { name: 'A1' } });
    await req('POST', '/universes', { headers: a.hdrs, body: { name: 'A2' } });
    await req('POST', '/universes', { headers: b.hdrs, body: { name: 'B1' } });

    const aList = await req('GET', '/universes', { headers: a.hdrs });
    expect(aList.status).toBe(200);
    const aBody = await json(aList);
    expect(aBody).toHaveLength(2);
    expect(aBody.every((u: any) => u.userId === a.user.id)).toBe(true);

    const bList = await req('GET', '/universes', { headers: b.hdrs });
    const bBody = await json(bList);
    expect(bBody).toHaveLength(1);
    expect(bBody[0].name).toBe('B1');
  });

  // UNIV-03: get owned
  it('GET /universes/:id returns universe when owned', async () => {
    const a = await userWithToken('a4@test.com');
    const createRes = await req('POST', '/universes', { headers: a.hdrs, body: { name: 'Mine' } });
    const created = await json(createRes);
    const res = await req('GET', `/universes/${created.id}`, { headers: a.hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.name).toBe('Mine');
  });

  // 404 when universe doesn't exist at all
  it('GET /universes/:id returns 404 for a nonexistent universe id', async () => {
    const a = await userWithToken('a5@test.com');
    const res = await req('GET', '/universes/00000000-0000-0000-0000-000000000000', { headers: a.hdrs });
    expect(res.status).toBe(404);
  });

  // UNIV-04: patch
  it('PATCH /universes/:id updates name', async () => {
    const a = await userWithToken('a6@test.com');
    const createRes = await req('POST', '/universes', { headers: a.hdrs, body: { name: 'Old' } });
    const created = await json(createRes);
    const res = await req('PATCH', `/universes/${created.id}`, { headers: a.hdrs, body: { name: 'New' } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.name).toBe('New');
  });

  it('PATCH /universes/:id updates description independently', async () => {
    const a = await userWithToken('a7@test.com');
    const createRes = await req('POST', '/universes', { headers: a.hdrs, body: { name: 'Keep' } });
    const created = await json(createRes);
    const res = await req('PATCH', `/universes/${created.id}`, { headers: a.hdrs, body: { description: 'Added later' } });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.name).toBe('Keep');
    expect(body.description).toBe('Added later');
  });

  it('PATCH /universes/:id rejects empty body with 400', async () => {
    const a = await userWithToken('a8@test.com');
    const createRes = await req('POST', '/universes', { headers: a.hdrs, body: { name: 'X' } });
    const created = await json(createRes);
    const res = await req('PATCH', `/universes/${created.id}`, { headers: a.hdrs, body: {} });
    expect(res.status).toBe(400);
  });

  // UNIV-05: delete
  it('DELETE /universes/:id removes the row', async () => {
    const a = await userWithToken('a9@test.com');
    const createRes = await req('POST', '/universes', { headers: a.hdrs, body: { name: 'Doomed' } });
    const created = await json(createRes);
    const del = await req('DELETE', `/universes/${created.id}`, { headers: a.hdrs });
    expect(del.status).toBe(204);
    const after = await handle.db.select().from(universes).where(eq(universes.id, created.id));
    expect(after).toHaveLength(0);
  });

  // UNIV-06: cross-tenant isolation returns 403
  it('cross-tenant GET /universes/:id returns 403', async () => {
    const a = await userWithToken('owner@test.com');
    const b = await userWithToken('stranger@test.com');
    const createRes = await req('POST', '/universes', { headers: a.hdrs, body: { name: 'Private' } });
    const created = await json(createRes);
    const peek = await req('GET', `/universes/${created.id}`, { headers: b.hdrs });
    expect(peek.status).toBe(403);
  });

  it('cross-tenant PATCH /universes/:id returns 403', async () => {
    const a = await userWithToken('owner2@test.com');
    const b = await userWithToken('stranger2@test.com');
    const createRes = await req('POST', '/universes', { headers: a.hdrs, body: { name: 'Locked' } });
    const created = await json(createRes);
    const attack = await req('PATCH', `/universes/${created.id}`, { headers: b.hdrs, body: { name: 'Hijacked' } });
    expect(attack.status).toBe(403);
    // And the row is unchanged
    const row = await handle.db.query.universes.findFirst({ where: eq(universes.id, created.id) });
    expect(row!.name).toBe('Locked');
  });

  it('cross-tenant DELETE /universes/:id returns 403 and row survives', async () => {
    const a = await userWithToken('owner3@test.com');
    const b = await userWithToken('stranger3@test.com');
    const createRes = await req('POST', '/universes', { headers: a.hdrs, body: { name: 'Safe' } });
    const created = await json(createRes);
    const attack = await req('DELETE', `/universes/${created.id}`, { headers: b.hdrs });
    expect(attack.status).toBe(403);
    const row = await handle.db.query.universes.findFirst({ where: eq(universes.id, created.id) });
    expect(row).toBeTruthy();
  });
});
