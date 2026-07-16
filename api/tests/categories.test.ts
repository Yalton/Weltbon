import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('categories routes (CAT-01..05)', () => {
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

  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createCategory(uid: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('POST', `/universes/${uid}/categories`, { headers: hdrs, body });
    return { status: res.status, data: await json(res) };
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const defaults = { title: 'Test Entry', entryType: 'concept' };
    const res = await req('POST', `/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  // ========== CAT-01: create category ==========
  describe('POST /universes/:uid/categories — CAT-01', () => {
    it('creates category with label + optional icon', async () => {
      const { hdrs } = await userWithToken('cat1@test.com');
      const universe = await createUniverse(hdrs);

      const { status, data } = await createCategory(universe.id, hdrs, { label: 'Locations', icon: '🗺️' });
      expect(status).toBe(201);
      expect(data.label).toBe('Locations');
      expect(data.icon).toBe('🗺️');
      expect(data.universeId).toBe(universe.id);
      expect(data.sortOrder).toBe(0);
      expect(typeof data.id).toBe('string');
    });

    it('creates category with defaulted empty icon when omitted', async () => {
      const { hdrs } = await userWithToken('cat1b@test.com');
      const universe = await createUniverse(hdrs);

      const { status, data } = await createCategory(universe.id, hdrs, { label: 'Factions' });
      expect(status).toBe(201);
      expect(data.label).toBe('Factions');
      expect(data.icon).toBe('');
    });

    it('assigns incrementing sort_order to successive categories', async () => {
      const { hdrs } = await userWithToken('cat1c@test.com');
      const universe = await createUniverse(hdrs);

      const a = await createCategory(universe.id, hdrs, { label: 'A' });
      const b = await createCategory(universe.id, hdrs, { label: 'B' });
      const c = await createCategory(universe.id, hdrs, { label: 'C' });
      expect(a.data.sortOrder).toBe(0);
      expect(b.data.sortOrder).toBe(1);
      expect(c.data.sortOrder).toBe(2);
    });

    it('rejects missing label with 400', async () => {
      const { hdrs } = await userWithToken('cat1d@test.com');
      const universe = await createUniverse(hdrs);
      const res = await req('POST', `/universes/${universe.id}/categories`, {
        headers: hdrs,
        body: { icon: '🗺️' },
      });
      expect(res.status).toBe(400);
    });
  });

  // ========== CAT-02: PATCH entry assigns categoryId ==========
  describe('PATCH /entries/:id — CAT-02', () => {
    it('assigns entry to a category via categoryId', async () => {
      const { hdrs } = await userWithToken('cat2@test.com');
      const universe = await createUniverse(hdrs);
      const cat = await createCategory(universe.id, hdrs, { label: 'Factions' });
      const entry = await createEntry(universe.id, hdrs, { title: 'The Guild' });

      const res = await req('PATCH', `/universes/${universe.id}/entries/${entry.id}`, {
        headers: hdrs,
        body: { categoryId: cat.data.id },
      });
      expect(res.status).toBe(200);
      const updated = await json(res);
      expect(updated.categoryId).toBe(cat.data.id);
    });

    it('clears category assignment when categoryId is null', async () => {
      const { hdrs } = await userWithToken('cat2b@test.com');
      const universe = await createUniverse(hdrs);
      const cat = await createCategory(universe.id, hdrs, { label: 'Factions' });
      const entry = await createEntry(universe.id, hdrs, { title: 'The Guild' });

      await req('PATCH', `/universes/${universe.id}/entries/${entry.id}`, {
        headers: hdrs,
        body: { categoryId: cat.data.id },
      });
      const res = await req('PATCH', `/universes/${universe.id}/entries/${entry.id}`, {
        headers: hdrs,
        body: { categoryId: null },
      });
      expect(res.status).toBe(200);
      const cleared = await json(res);
      expect(cleared.categoryId).toBeNull();
    });

    it('rejects categoryId belonging to another universe with 400', async () => {
      const { hdrs } = await userWithToken('cat2c@test.com');
      const uniA = await createUniverse(hdrs, 'A');
      const uniB = await createUniverse(hdrs, 'B');
      const catB = await createCategory(uniB.id, hdrs, { label: 'OnlyInB' });
      const entryA = await createEntry(uniA.id, hdrs, { title: 'In A' });

      const res = await req('PATCH', `/universes/${uniA.id}/entries/${entryA.id}`, {
        headers: hdrs,
        body: { categoryId: catB.data.id },
      });
      expect(res.status).toBe(400);
    });
  });

  // ========== CAT-03: reorder ==========
  describe('PUT /categories/reorder — CAT-03', () => {
    it('rewrites sort_order in the order of ids provided', async () => {
      const { hdrs } = await userWithToken('cat3@test.com');
      const universe = await createUniverse(hdrs);
      const a = await createCategory(universe.id, hdrs, { label: 'A' });
      const b = await createCategory(universe.id, hdrs, { label: 'B' });
      const c = await createCategory(universe.id, hdrs, { label: 'C' });

      // Reverse order: C, A, B
      const reorderRes = await req('PUT', `/universes/${universe.id}/categories/reorder`, {
        headers: hdrs,
        body: { orderedIds: [c.data.id, a.data.id, b.data.id] },
      });
      expect(reorderRes.status).toBe(200);

      const listRes = await req('GET', `/universes/${universe.id}/categories`, { headers: hdrs });
      const list = await json(listRes);
      const labels = list.categories.map((r: { label: string }) => r.label);
      expect(labels).toEqual(['C', 'A', 'B']);
      // sortOrder now 0..2 in iteration order
      expect(list.categories.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([0, 1, 2]);
    });

    it('rejects reorder when any id belongs to a different universe with 400', async () => {
      const { hdrs } = await userWithToken('cat3b@test.com');
      const uniA = await createUniverse(hdrs, 'A');
      const uniB = await createUniverse(hdrs, 'B');
      const a = await createCategory(uniA.id, hdrs, { label: 'A' });
      const b = await createCategory(uniB.id, hdrs, { label: 'B' });

      const res = await req('PUT', `/universes/${uniA.id}/categories/reorder`, {
        headers: hdrs,
        body: { orderedIds: [a.data.id, b.data.id] },
      });
      expect(res.status).toBe(400);
    });
  });

  // ========== CAT-04: DELETE nulls entry.category_id ==========
  describe('DELETE /categories/:id sets entries.category_id NULL — CAT-04', () => {
    it('deleting a category nulls category_id on its entries (ON DELETE SET NULL)', async () => {
      const { hdrs } = await userWithToken('cat4@test.com');
      const universe = await createUniverse(hdrs);
      const cat = await createCategory(universe.id, hdrs, { label: 'Temp' });
      const entry = await createEntry(universe.id, hdrs, { title: 'Assigned' });

      await req('PATCH', `/universes/${universe.id}/entries/${entry.id}`, {
        headers: hdrs,
        body: { categoryId: cat.data.id },
      });

      const delRes = await req('DELETE', `/universes/${universe.id}/categories/${cat.data.id}`, { headers: hdrs });
      expect(delRes.status).toBe(204);

      const getRes = await req('GET', `/universes/${universe.id}/entries/${entry.id}`, { headers: hdrs });
      const fresh = await json(getRes);
      expect(fresh.categoryId).toBeNull();
    });
  });

  // ========== CAT-05: GET with entry count join ==========
  describe('GET /categories returns entries count join — CAT-05', () => {
    it('returns categories with per-category entryCount + uncategorizedCount', async () => {
      const { hdrs } = await userWithToken('cat5@test.com');
      const universe = await createUniverse(hdrs);
      const locations = await createCategory(universe.id, hdrs, { label: 'Locations' });
      const factions = await createCategory(universe.id, hdrs, { label: 'Factions' });

      const e1 = await createEntry(universe.id, hdrs, { title: 'Capital' });
      const e2 = await createEntry(universe.id, hdrs, { title: 'Harbor' });
      const e3 = await createEntry(universe.id, hdrs, { title: 'Guild' });
      // e4 stays uncategorized
      await createEntry(universe.id, hdrs, { title: 'Loose Note' });

      await req('PATCH', `/universes/${universe.id}/entries/${e1.id}`, {
        headers: hdrs,
        body: { categoryId: locations.data.id },
      });
      await req('PATCH', `/universes/${universe.id}/entries/${e2.id}`, {
        headers: hdrs,
        body: { categoryId: locations.data.id },
      });
      await req('PATCH', `/universes/${universe.id}/entries/${e3.id}`, {
        headers: hdrs,
        body: { categoryId: factions.data.id },
      });

      const res = await req('GET', `/universes/${universe.id}/categories`, { headers: hdrs });
      expect(res.status).toBe(200);
      const payload = await json(res);
      expect(payload.uncategorizedCount).toBe(1);

      const byLabel = new Map<string, { entryCount: number }>(
        payload.categories.map((c: { label: string; entryCount: number }) => [c.label, c])
      );
      expect(byLabel.get('Locations')!.entryCount).toBe(2);
      expect(byLabel.get('Factions')!.entryCount).toBe(1);
    });

    it('empty universe returns zero counts', async () => {
      const { hdrs } = await userWithToken('cat5b@test.com');
      const universe = await createUniverse(hdrs);
      const res = await req('GET', `/universes/${universe.id}/categories`, { headers: hdrs });
      expect(res.status).toBe(200);
      const payload = await json(res);
      expect(payload.categories).toEqual([]);
      expect(payload.uncategorizedCount).toBe(0);
    });
  });

  // ========== PATCH category (label/icon) ==========
  describe('PATCH /categories/:id', () => {
    it('updates label and/or icon', async () => {
      const { hdrs } = await userWithToken('cat-patch@test.com');
      const universe = await createUniverse(hdrs);
      const cat = await createCategory(universe.id, hdrs, { label: 'Old', icon: '🧓' });

      const res = await req('PATCH', `/universes/${universe.id}/categories/${cat.data.id}`, {
        headers: hdrs,
        body: { label: 'New', icon: '🆕' },
      });
      expect(res.status).toBe(200);
      const updated = await json(res);
      expect(updated.label).toBe('New');
      expect(updated.icon).toBe('🆕');
    });

    it('returns 404 for nonexistent category', async () => {
      const { hdrs } = await userWithToken('cat-patch-nope@test.com');
      const universe = await createUniverse(hdrs);
      const res = await req('PATCH', `/universes/${universe.id}/categories/00000000-0000-0000-0000-000000000000`, {
        headers: hdrs,
        body: { label: 'Nope' },
      });
      expect(res.status).toBe(404);
    });
  });

  // ========== Cross-tenant 403 ==========
  describe('cross-tenant access returns 403', () => {
    it('stranger cannot list, create, patch, delete, or reorder categories', async () => {
      const owner = await userWithToken('owner-cat@test.com');
      const stranger = await userWithToken('stranger-cat@test.com');
      const universe = await createUniverse(owner.hdrs);
      const cat = await createCategory(universe.id, owner.hdrs, { label: 'Private' });

      expect((await req('GET', `/universes/${universe.id}/categories`, { headers: stranger.hdrs })).status).toBe(403);
      expect((await req('POST', `/universes/${universe.id}/categories`, {
        headers: stranger.hdrs,
        body: { label: 'Hijack' },
      })).status).toBe(403);
      expect((await req('PATCH', `/universes/${universe.id}/categories/${cat.data.id}`, {
        headers: stranger.hdrs,
        body: { label: 'Stolen' },
      })).status).toBe(403);
      expect((await req('DELETE', `/universes/${universe.id}/categories/${cat.data.id}`, {
        headers: stranger.hdrs,
      })).status).toBe(403);
      expect((await req('PUT', `/universes/${universe.id}/categories/reorder`, {
        headers: stranger.hdrs,
        body: { orderedIds: [cat.data.id] },
      })).status).toBe(403);
    });
  });
});
