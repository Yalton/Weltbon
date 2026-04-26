import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { entries, universes } from '../src/db/schema.js';
import { setTestDb } from '../src/db/client.js';

describe('universe entry-types CRUD (POL-02)', () => {
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

  // ========== PATCH add ==========
  describe('PATCH /universes/:id/entry-types — action=add', () => {
    it('appends a new type and dedupes case-sensitively', async () => {
      const { hdrs } = await userWithToken('add@test.com');
      const universe = await createUniverse(hdrs);

      const res1 = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: hdrs,
        body: { action: 'add', name: 'mythos' },
      });
      expect(res1.status).toBe(200);
      const updated = await json(res1);
      expect(updated.entryTypes).toContain('mythos');

      // Second add returns 409 duplicate_type
      const res2 = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: hdrs,
        body: { action: 'add', name: 'mythos' },
      });
      expect(res2.status).toBe(409);
      const err = await json(res2);
      expect(err.error).toBe('duplicate_type');
    });

    it('rejects empty or oversize names with 400', async () => {
      const { hdrs } = await userWithToken('add-bad@test.com');
      const universe = await createUniverse(hdrs);

      const empty = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: hdrs,
        body: { action: 'add', name: '' },
      });
      expect(empty.status).toBe(400);

      const long = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: hdrs,
        body: { action: 'add', name: 'x'.repeat(51) },
      });
      expect(long.status).toBe(400);
    });

    it('trims whitespace before insertion', async () => {
      const { hdrs } = await userWithToken('add-trim@test.com');
      const universe = await createUniverse(hdrs);

      const res = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: hdrs,
        body: { action: 'add', name: '  mythos  ' },
      });
      expect(res.status).toBe(200);
      const updated = await json(res);
      expect(updated.entryTypes).toContain('mythos');
      expect(updated.entryTypes).not.toContain('  mythos  ');
    });
  });

  // ========== PATCH rename ==========
  describe('PATCH /universes/:id/entry-types — action=rename', () => {
    it('replaces in entryTypes AND cascades to entries.entry_type in one tx', async () => {
      const { hdrs } = await userWithToken('rename@test.com');
      const universe = await createUniverse(hdrs);
      // Create a few entries of type 'concept'
      const e1 = await createEntry(universe.id, hdrs, { title: 'E1', entryType: 'concept' });
      const e2 = await createEntry(universe.id, hdrs, { title: 'E2', entryType: 'concept' });
      const e3 = await createEntry(universe.id, hdrs, { title: 'E3', entryType: 'location' });

      const res = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: hdrs,
        body: { action: 'rename', oldName: 'concept', newName: 'idea' },
      });
      expect(res.status).toBe(200);
      const updated = await json(res);
      expect(updated.entryTypes).toContain('idea');
      expect(updated.entryTypes).not.toContain('concept');

      // Cascade: e1 + e2 (formerly concept) now 'idea'; e3 ('location') unchanged
      const rows = await handle.db.select().from(entries).where(eq(entries.universeId, universe.id));
      const byId = new Map(rows.map((r) => [r.id, r.entryType]));
      expect(byId.get(e1.id)).toBe('idea');
      expect(byId.get(e2.id)).toBe('idea');
      expect(byId.get(e3.id)).toBe('location');
    });

    it('returns 400 unknown_type when oldName not in entryTypes', async () => {
      const { hdrs } = await userWithToken('rename-unknown@test.com');
      const universe = await createUniverse(hdrs);

      const res = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: hdrs,
        body: { action: 'rename', oldName: 'nonexistent', newName: 'whatever' },
      });
      expect(res.status).toBe(400);
      const err = await json(res);
      expect(err.error).toBe('unknown_type');
    });

    it('returns 409 duplicate_type when newName already in entryTypes', async () => {
      const { hdrs } = await userWithToken('rename-dup@test.com');
      const universe = await createUniverse(hdrs);

      const res = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: hdrs,
        body: { action: 'rename', oldName: 'concept', newName: 'location' },
      });
      expect(res.status).toBe(409);
      const err = await json(res);
      expect(err.error).toBe('duplicate_type');
    });
  });

  // ========== DELETE /entry-types/:name ==========
  describe('DELETE /universes/:id/entry-types/:name', () => {
    it('returns 204 and removes type when no entries use it', async () => {
      const { hdrs } = await userWithToken('del-empty@test.com');
      const universe = await createUniverse(hdrs);

      const res = await req('DELETE', `/universes/${universe.id}/entry-types/artifact`, {
        headers: hdrs,
      });
      expect(res.status).toBe(204);

      // Confirm gone from entry_types
      const row = await handle.db.query.universes.findFirst({
        where: eq(universes.id, universe.id),
      });
      expect(row!.entryTypes).not.toContain('artifact');
    });

    it('without ?fallback returns 409 + count + type when entries use it', async () => {
      const { hdrs } = await userWithToken('del-409@test.com');
      const universe = await createUniverse(hdrs);
      await createEntry(universe.id, hdrs, { title: 'A', entryType: 'concept' });
      await createEntry(universe.id, hdrs, { title: 'B', entryType: 'concept' });
      await createEntry(universe.id, hdrs, { title: 'C', entryType: 'concept' });

      const res = await req('DELETE', `/universes/${universe.id}/entry-types/concept`, {
        headers: hdrs,
      });
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.error).toBe('entries_using_type');
      expect(body.count).toBe(3);
      expect(body.type).toBe('concept');

      // Type still present (no destructive action taken)
      const row = await handle.db.query.universes.findFirst({
        where: eq(universes.id, universe.id),
      });
      expect(row!.entryTypes).toContain('concept');
    });

    it('with valid ?fallback cascades entries to fallback and removes type (single tx)', async () => {
      const { hdrs } = await userWithToken('del-cascade@test.com');
      const universe = await createUniverse(hdrs);
      const e1 = await createEntry(universe.id, hdrs, { title: 'A', entryType: 'concept' });
      const e2 = await createEntry(universe.id, hdrs, { title: 'B', entryType: 'concept' });
      const e3 = await createEntry(universe.id, hdrs, { title: 'C', entryType: 'location' });

      const res = await req(
        'DELETE',
        `/universes/${universe.id}/entry-types/concept?fallback=entity`,
        { headers: hdrs }
      );
      expect(res.status).toBe(204);

      // Type removed
      const row = await handle.db.query.universes.findFirst({
        where: eq(universes.id, universe.id),
      });
      expect(row!.entryTypes).not.toContain('concept');
      expect(row!.entryTypes).toContain('entity');

      // Affected entries cascaded; non-affected unchanged
      const all = await handle.db.select().from(entries).where(eq(entries.universeId, universe.id));
      const byId = new Map(all.map((r) => [r.id, r.entryType]));
      expect(byId.get(e1.id)).toBe('entity');
      expect(byId.get(e2.id)).toBe('entity');
      expect(byId.get(e3.id)).toBe('location');
    });

    it('returns 400 invalid_fallback when fallback === name being deleted', async () => {
      const { hdrs } = await userWithToken('del-self@test.com');
      const universe = await createUniverse(hdrs);
      await createEntry(universe.id, hdrs, { title: 'A', entryType: 'concept' });

      const res = await req(
        'DELETE',
        `/universes/${universe.id}/entry-types/concept?fallback=concept`,
        { headers: hdrs }
      );
      expect(res.status).toBe(400);
      const err = await json(res);
      expect(err.error).toBe('invalid_fallback');
    });

    it('returns 400 invalid_fallback when fallback not in entry_types', async () => {
      const { hdrs } = await userWithToken('del-bad-fb@test.com');
      const universe = await createUniverse(hdrs);
      await createEntry(universe.id, hdrs, { title: 'A', entryType: 'concept' });

      const res = await req(
        'DELETE',
        `/universes/${universe.id}/entry-types/concept?fallback=nonexistent`,
        { headers: hdrs }
      );
      expect(res.status).toBe(400);
      const err = await json(res);
      expect(err.error).toBe('invalid_fallback');
    });

    it('returns 404 unknown_type for a name not in entry_types', async () => {
      const { hdrs } = await userWithToken('del-unknown@test.com');
      const universe = await createUniverse(hdrs);

      const res = await req('DELETE', `/universes/${universe.id}/entry-types/nonexistent`, {
        headers: hdrs,
      });
      expect(res.status).toBe(404);
      const err = await json(res);
      expect(err.error).toBe('unknown_type');
    });
  });

  // ========== Cross-tenant 403 ==========
  describe('cross-tenant access returns 403', () => {
    it('all entry-types endpoints reject strangers', async () => {
      const owner = await userWithToken('owner-types@test.com');
      const stranger = await userWithToken('stranger-types@test.com');
      const universe = await createUniverse(owner.hdrs);

      const addRes = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: stranger.hdrs,
        body: { action: 'add', name: 'hijack' },
      });
      expect(addRes.status).toBe(403);

      const renameRes = await req('PATCH', `/universes/${universe.id}/entry-types`, {
        headers: stranger.hdrs,
        body: { action: 'rename', oldName: 'concept', newName: 'stolen' },
      });
      expect(renameRes.status).toBe(403);

      const delRes = await req('DELETE', `/universes/${universe.id}/entry-types/concept`, {
        headers: stranger.hdrs,
      });
      expect(delRes.status).toBe(403);
    });
  });
});
