import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { timelinePins } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

// TIME-01..04 integration coverage:
//  - POST /entries/:id/pin upserts (insert + duplicate POST replaces, no second row)
//  - DB UNIQUE on entry_id rejects manual double-INSERT (23505)
//  - Zod rejects non-finite position + bad precision
//  - requireUniverse 403 on cross-tenant pin POST/DELETE/GET
//  - DELETE /pin returns 204; 404 if no pin
//  - Entry delete cascades pin row (FK)
//  - GET /timeline returns sorted ASC by position with extreme floats (-10000, 0, 4.35e17)
//  - GET /timeline includes joined entry title + type + icon
describe('Timeline API (TIME-01..04)', () => {
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

  async function createUniverse(hdrs: Record<string, string>, name = 'TimelineWorld') {
    const res = await req('POST', '/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const defaults = { title: 'Test Entry', entryType: 'event' };
    const res = await req('POST', `/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  // ----- TIME-01: POST upsert -----

  it('POST /entries/:id/pin creates a pin (200) with returned id, label, position, precision', async () => {
    const { hdrs } = await userWithToken('pin1@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Anchor' });

    const res = await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: 'First era', position: 1234.5, precision: 'exact' },
    });

    expect(res.status).toBe(200);
    const pin = await json(res);
    expect(typeof pin.id).toBe('string');
    expect(pin.entryId).toBe(entry.id);
    expect(pin.label).toBe('First era');
    expect(pin.position).toBe(1234.5);
    expect(pin.precision).toBe('exact');
  });

  it('Second POST for the same entry replaces the row (DB row count stays 1)', async () => {
    const { hdrs } = await userWithToken('pin-upsert@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Replaceable' });

    const r1 = await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: 'Original', position: 100, precision: 'exact' },
    });
    expect(r1.status).toBe(200);
    const first = await json(r1);

    const r2 = await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: 'Replaced', position: 999, precision: 'approximate' },
    });
    expect(r2.status).toBe(200);
    const second = await json(r2);

    // Same row id (UPDATE, not new INSERT)
    expect(second.id).toBe(first.id);
    expect(second.label).toBe('Replaced');
    expect(second.position).toBe(999);
    expect(second.precision).toBe('approximate');

    // Direct DB query: exactly one row for this entry
    const rows = await handle.db.select().from(timelinePins).where(eq(timelinePins.entryId, entry.id));
    expect(rows).toHaveLength(1);
  });

  it('DB UNIQUE constraint rejects manual double-INSERT with 23505', async () => {
    const { hdrs } = await userWithToken('pin-unique@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Unique Test' });

    await handle.db.insert(timelinePins).values({
      entryId: entry.id,
      label: 'first',
      position: 1,
      precision: 'exact',
    });

    let caught: any;
    try {
      await handle.db.insert(timelinePins).values({
        entryId: entry.id,
        label: 'second',
        position: 2,
        precision: 'exact',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // pg error code 23505 = unique_violation. Drizzle wraps the underlying
    // pg error; the original error code may be on `.cause` or on the wrapper
    // itself depending on drizzle/pg versions.
    const code = caught.code ?? caught.cause?.code;
    expect(code).toBe('23505');
  });

  it('Zod rejects non-finite position (NaN, Infinity, "abc")', async () => {
    const { hdrs } = await userWithToken('pin-bad-pos@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'BadPos' });

    // JSON cannot represent NaN/Infinity directly; send as string and as a JSON `null`
    // to confirm Zod rejects all of them with 400.
    const sendRaw = (body: string) =>
      app.request(`http://localhost/api/universes/${universe.id}/entries/${entry.id}/pin`, {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body,
      });

    // String "abc" — fails number type
    const r1 = await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: 'L', position: 'abc', precision: 'exact' },
    });
    expect(r1.status).toBe(400);

    // Raw JSON with NaN-like literal: send `position: null` (JSON has no NaN literal)
    const r2 = await sendRaw('{"label":"L","position":null,"precision":"exact"}');
    expect(r2.status).toBe(400);

    // Raw JSON with sentinel that JSON.parse turns into Infinity? JSON spec disallows.
    // Send a string-encoded Infinity which Zod will refuse since it isn't a number.
    const r3 = await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: 'L', position: 'Infinity', precision: 'exact' },
    });
    expect(r3.status).toBe(400);
  });

  it('Zod rejects precision not in enum', async () => {
    const { hdrs } = await userWithToken('pin-bad-prec@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'BadPrec' });

    const res = await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: 'L', position: 1, precision: 'wrong' },
    });
    expect(res.status).toBe(400);
  });

  it('Zod accepts empty label (optional in UI)', async () => {
    const { hdrs } = await userWithToken('pin-empty-label@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'EmptyLabel' });

    const res = await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: '', position: 1, precision: 'exact' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.label).toBe('');
  });

  it('POST 404 when entry does not exist in this universe', async () => {
    const { hdrs } = await userWithToken('pin-no-entry@test.com');
    const universe = await createUniverse(hdrs);
    const res = await req('POST', `/universes/${universe.id}/entries/00000000-0000-0000-0000-000000000000/pin`, {
      headers: hdrs,
      body: { label: 'L', position: 1, precision: 'exact' },
    });
    expect(res.status).toBe(404);
  });

  // ----- DELETE -----

  it('DELETE /pin returns 204 on success', async () => {
    const { hdrs } = await userWithToken('pin-del@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'ToDelete' });

    await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: 'L', position: 1, precision: 'exact' },
    });

    const del = await req('DELETE', `/universes/${universe.id}/entries/${entry.id}/pin`, { headers: hdrs });
    expect(del.status).toBe(204);

    // Verify DB
    const rows = await handle.db.select().from(timelinePins).where(eq(timelinePins.entryId, entry.id));
    expect(rows).toHaveLength(0);
  });

  it('DELETE /pin returns 404 when no pin exists for the entry', async () => {
    const { hdrs } = await userWithToken('pin-del-404@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'NoPin' });

    const del = await req('DELETE', `/universes/${universe.id}/entries/${entry.id}/pin`, { headers: hdrs });
    expect(del.status).toBe(404);
  });

  // ----- Cascade -----

  it('Deleting the entry cascades the pin row (FK ON DELETE CASCADE)', async () => {
    const { hdrs } = await userWithToken('pin-cascade@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Doomed' });

    await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: hdrs,
      body: { label: 'L', position: 1, precision: 'exact' },
    });

    // Verify pin exists
    const before = await handle.db.select().from(timelinePins).where(eq(timelinePins.entryId, entry.id));
    expect(before).toHaveLength(1);

    // Delete the entry through its DELETE endpoint
    const del = await req('DELETE', `/universes/${universe.id}/entries/${entry.id}`, { headers: hdrs });
    expect(del.status).toBe(204);

    // Pin row gone
    const after = await handle.db.select().from(timelinePins).where(eq(timelinePins.entryId, entry.id));
    expect(after).toHaveLength(0);
  });

  // ----- GET /timeline sorting -----

  it('GET /timeline returns ASC-sorted pins across extreme float positions', async () => {
    const { hdrs } = await userWithToken('timeline-sort@test.com');
    const universe = await createUniverse(hdrs);

    const e1 = await createEntry(universe.id, hdrs, { title: 'Far Future', entryType: 'event', icon: '🚀' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'Year Zero', entryType: 'event', icon: '🌟' });
    const e3 = await createEntry(universe.id, hdrs, { title: 'Deep Past', entryType: 'event', icon: '🦴' });

    // Insert in NON-sorted order to confirm DB sort actually runs
    await req('POST', `/universes/${universe.id}/entries/${e1.id}/pin`, {
      headers: hdrs,
      body: { label: 'Heat death', position: 4.35e17, precision: 'era' },
    });
    await req('POST', `/universes/${universe.id}/entries/${e3.id}/pin`, {
      headers: hdrs,
      body: { label: 'Antiquity', position: -10000, precision: 'approximate' },
    });
    await req('POST', `/universes/${universe.id}/entries/${e2.id}/pin`, {
      headers: hdrs,
      body: { label: 'Origin', position: 0, precision: 'exact' },
    });

    const res = await req('GET', `/universes/${universe.id}/timeline`, { headers: hdrs });
    expect(res.status).toBe(200);
    const list = await json(res);

    expect(list).toHaveLength(3);
    // Sorted ASC by position: -10000, 0, 4.35e17
    expect(list[0].entryId).toBe(e3.id);
    expect(list[0].position).toBe(-10000);
    expect(list[1].entryId).toBe(e2.id);
    expect(list[1].position).toBe(0);
    expect(list[2].entryId).toBe(e1.id);
    // Float8 round-trip preserves 4.35e17 exactly
    expect(list[2].position).toBe(4.35e17);

    // Joined entry data present
    expect(list[0].entryTitle).toBe('Deep Past');
    expect(list[0].entryIcon).toBe('🦴');
    expect(list[0].entryType).toBe('event');
    expect(list[2].entryTitle).toBe('Far Future');
    expect(list[2].entryIcon).toBe('🚀');
  });

  it('GET /timeline returns empty array when no pins', async () => {
    const { hdrs } = await userWithToken('timeline-empty@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('GET', `/universes/${universe.id}/timeline`, { headers: hdrs });
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(list).toEqual([]);
  });

  // ----- Cross-tenant 403 -----

  it('cross-tenant access returns 403 on POST/DELETE/GET', async () => {
    const a = await userWithToken('owner-tl@test.com');
    const b = await userWithToken('stranger-tl@test.com');
    const universe = await createUniverse(a.hdrs);
    const entry = await createEntry(universe.id, a.hdrs, { title: 'Mine' });

    // owner pins
    await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: a.hdrs,
      body: { label: 'L', position: 1, precision: 'exact' },
    });

    // stranger gets 403 everywhere
    const post = await req('POST', `/universes/${universe.id}/entries/${entry.id}/pin`, {
      headers: b.hdrs,
      body: { label: 'Evil', position: 2, precision: 'exact' },
    });
    expect(post.status).toBe(403);

    const del = await req('DELETE', `/universes/${universe.id}/entries/${entry.id}/pin`, { headers: b.hdrs });
    expect(del.status).toBe(403);

    const get = await req('GET', `/universes/${universe.id}/timeline`, { headers: b.hdrs });
    expect(get.status).toBe(403);
  });
});
