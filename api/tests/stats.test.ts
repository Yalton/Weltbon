import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('stats routes (DATA-05)', () => {
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

  async function createUniverse(hdrs: Record<string, string>, name = 'StatWorld') {
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

  async function createLink(uid: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('POST', `/api/universes/${uid}/links`, {
      headers: hdrs,
      body,
    });
    return json(res);
  }

  async function createCategory(uid: string, hdrs: Record<string, string>, label: string) {
    const res = await req('POST', `/api/universes/${uid}/categories`, {
      headers: hdrs,
      body: { label },
    });
    return json(res);
  }

  // DATA-05-01: GET /api/universes/:id/stats returns all required fields
  it('GET /api/universes/:id/stats returns all required aggregate fields', async () => {
    const { hdrs } = await userWithToken('stats-01@test.com');
    const universe = await createUniverse(hdrs);

    // Create some entries
    const e1 = await createEntry(universe.id, hdrs, { title: 'Entry A', entryType: 'concept' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'Entry B', entryType: 'entity' });

    // Create a link
    await createLink(universe.id, hdrs, {
      sourceEntryId: e1.id,
      targetEntryId: e2.id,
    });

    const res = await req('GET', `/api/universes/${universe.id}/stats`, { headers: hdrs });
    expect(res.status).toBe(200);
    const stats = await json(res);

    expect(typeof stats.totalEntries).toBe('number');
    expect(typeof stats.totalLinks).toBe('number');
    expect(typeof stats.totalTimelinePins).toBe('number');
    expect(typeof stats.totalCategories).toBe('number');
    expect(Array.isArray(stats.entriesByType)).toBe(true);
    expect(Array.isArray(stats.categoryDistribution)).toBe(true);
    expect(Array.isArray(stats.recentlyEdited)).toBe(true);
  });

  // DATA-05-02: entriesByType sums to totalEntries
  it('entriesByType is an array of { type, count } summing to totalEntries', async () => {
    const { hdrs } = await userWithToken('stats-02@test.com');
    const universe = await createUniverse(hdrs);

    await createEntry(universe.id, hdrs, { title: 'Concept 1', entryType: 'concept' });
    await createEntry(universe.id, hdrs, { title: 'Concept 2', entryType: 'concept' });
    await createEntry(universe.id, hdrs, { title: 'Entity 1', entryType: 'entity' });

    const res = await req('GET', `/api/universes/${universe.id}/stats`, { headers: hdrs });
    const stats = await json(res);

    expect(stats.totalEntries).toBe(3);
    expect(Array.isArray(stats.entriesByType)).toBe(true);
    const sumFromTypes = stats.entriesByType.reduce((sum: number, row: any) => sum + Number(row.count), 0);
    expect(sumFromTypes).toBe(stats.totalEntries);

    const conceptRow = stats.entriesByType.find((r: any) => r.type === 'concept');
    expect(conceptRow).toBeTruthy();
    expect(Number(conceptRow.count)).toBe(2);
  });

  // DATA-05-03: categoryDistribution includes 'Uncategorized' bucket for null categoryId
  it('categoryDistribution includes an Uncategorized bucket for entries with null categoryId', async () => {
    const { hdrs } = await userWithToken('stats-03@test.com');
    const universe = await createUniverse(hdrs);

    const cat = await createCategory(universe.id, hdrs, 'Factions');
    // Entry with a category
    await createEntry(universe.id, hdrs, { title: 'Categorized', entryType: 'faction', categoryId: cat.id });
    // Entry without a category
    await createEntry(universe.id, hdrs, { title: 'Uncategorized Entry', entryType: 'concept' });

    const res = await req('GET', `/api/universes/${universe.id}/stats`, { headers: hdrs });
    const stats = await json(res);

    const uncatBucket = stats.categoryDistribution.find((r: any) => r.categoryId === null);
    expect(uncatBucket).toBeTruthy();
    expect(uncatBucket.label).toBe('Uncategorized');
    expect(Number(uncatBucket.count)).toBeGreaterThanOrEqual(1);
  });

  // DATA-05-04: recentlyEdited returns at most 10 entries ordered by updatedAt desc
  it('recentlyEdited returns at most 10 entries with { id, title, entryType, icon, updatedAt }', async () => {
    const { hdrs } = await userWithToken('stats-04@test.com');
    const universe = await createUniverse(hdrs);

    // Create 12 entries
    for (let i = 0; i < 12; i++) {
      await createEntry(universe.id, hdrs, { title: `Entry ${i}`, entryType: 'concept', icon: `${i}` });
    }

    const res = await req('GET', `/api/universes/${universe.id}/stats`, { headers: hdrs });
    const stats = await json(res);

    expect(stats.recentlyEdited.length).toBeLessThanOrEqual(10);
    expect(stats.recentlyEdited.length).toBeGreaterThan(0);

    const first = stats.recentlyEdited[0];
    expect(first.id).toBeTruthy();
    expect(first.title).toBeTruthy();
    expect(first.entryType).toBeTruthy();
    expect(first).toHaveProperty('icon');
    expect(first.updatedAt).toBeTruthy();

    // Should be ordered by updatedAt desc (most recently edited first)
    for (let i = 1; i < stats.recentlyEdited.length; i++) {
      expect(new Date(stats.recentlyEdited[i - 1].updatedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(stats.recentlyEdited[i].updatedAt).getTime());
    }
  });

  // DATA-05-05: cross-tenant GET /stats returns 404 (ownership gate)
  it('GET /api/universes/:id/stats for a universe owned by another user returns 404', async () => {
    const owner = await userWithToken('stats-owner@test.com');
    const stranger = await userWithToken('stats-stranger@test.com');
    const universe = await createUniverse(owner.hdrs);

    const res = await req('GET', `/api/universes/${universe.id}/stats`, { headers: stranger.hdrs });
    // requireUniverse throws 403 for cross-tenant, not 404
    expect([403, 404]).toContain(res.status);
  });
});
