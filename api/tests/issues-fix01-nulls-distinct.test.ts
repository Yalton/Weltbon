import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { issues } from '../src/db/schema.js';

// FIX-01 (Phase 34): the issues_universe_gap_key_unique index was recreated in
// migration 0019 WITHOUT the equal-nulls clause (Postgres default = NULLs distinct).
// This locks both halves of the dedup-integrity invariant:
//   (a) unlimited gap_key = NULL (human-authored) issues per universe, and
//   (b) non-null (universe_id, gap_key) is still unique so AI dedup holds.
describe('issues FIX-01: gap_key nulls-distinct uniqueness', () => {
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

  // NOTE: API routes are mounted under the `/api` prefix (api/src/index.ts:141
  // `app.route('/api', apiR)`). The older issues.test.ts / universes.test.ts post
  // to bare `/universes` and 404 as a result (the documented "position 4" baseline
  // failure). This file uses the correct `/api/...` paths so it genuinely exercises
  // the routes and proves FIX-01. No production route/type/schema is modified (D-03).
  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    return res.json();
  }

  /** Seed an issue row directly (bypasses the HTTP layer) so we can set gap_key. */
  async function seedIssue(universeId: string, gapKey: string | null) {
    const [row] = await handle.db
      .insert(issues)
      .values({
        universeId,
        title: gapKey ? 'AI Finding' : 'Manual Issue',
        severity: 'minor',
        source: gapKey ? 'ai' : 'human',
        gapKey,
      })
      .returning();
    return row;
  }

  // FIX-01 SC#5: the regression that was broken before 0019 — a second manual
  // (gap_key = NULL) issue in the same universe was rejected by the equal-nulls index.
  it('allows two manual (gap_key=NULL) issues in the same universe via POST', async () => {
    const { hdrs } = await userWithToken('fix01-a@test.com');
    const universe = await createUniverse(hdrs);

    const first = await req('POST', `/api/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'First manual issue', severity: 'major' },
    });
    expect(first.status).toBe(201);

    const second = await req('POST', `/api/universes/${universe.id}/issues`, {
      headers: hdrs,
      body: { title: 'Second manual issue', severity: 'minor' },
    });
    expect(second.status).toBe(201);

    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(firstBody.id).not.toBe(secondBody.id);
  });

  // Dedup integrity: a duplicate NON-NULL gap_key in the same universe must still collide.
  it('rejects a duplicate non-null gap_key in the same universe', async () => {
    const { hdrs } = await userWithToken('fix01-b@test.com');
    const universe = await createUniverse(hdrs);

    await seedIssue(universe.id, 'G1');
    await expect(seedIssue(universe.id, 'G1')).rejects.toThrow();
  });

  // Uniqueness is per (universe_id, gap_key), not global: same gap_key in two universes is fine.
  it('allows the same non-null gap_key in two different universes', async () => {
    const { hdrs } = await userWithToken('fix01-c@test.com');
    const u1 = await createUniverse(hdrs, 'World One');
    const u2 = await createUniverse(hdrs, 'World Two');

    const a = await seedIssue(u1.id, 'SHARED');
    const b = await seedIssue(u2.id, 'SHARED');
    expect(a.id).not.toBe(b.id);
  });
});
