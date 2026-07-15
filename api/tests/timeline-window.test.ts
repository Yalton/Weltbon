import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { loadUniverseExportPayload } from '../src/services/export/payload.js';
import { importUniverseJson } from '../src/services/import-json.js';

/**
 * Phase 20 D-01 — DB-gated round-trip coverage for universes.timeline_window:
 *  - PATCH /universes/:id accepts { timelineWindow }
 *  - GET /universes/:id returns the persisted value
 *  - PATCH with null clears the window
 *  - JSON export emits universe.timelineWindow; importUniverseJson
 *    persists it (and tolerates missing field → null default)
 *
 * Registered in api/vitest.config.ts DB_GATED_TESTS so it joins the
 * integration lane only.
 */
describe('Timeline window (Phase 20 D-01)', () => {
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

  async function createUniverse(hdrs: Record<string, string>, name = 'TW-Test') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    expect(res.status).toBe(201);
    return json(res);
  }

  it('PATCH /universes/:id accepts timelineWindow and returns it in the response', async () => {
    const { hdrs } = await userWithToken('tw1@test.com');
    const universe = await createUniverse(hdrs);
    // GET before patching: new universe defaults to null (D-02 first-visit cue).
    const before = await json(await req('GET', `/api/universes/${universe.id}`, { headers: hdrs }));
    expect(before.timelineWindow).toBeNull();

    const patchRes = await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: { timelineWindow: { start: -10000, end: 26000 } },
    });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.timelineWindow).toEqual({ start: -10000, end: 26000 });
  });

  it('GET /universes/:id returns the persisted timelineWindow after PATCH', async () => {
    const { hdrs } = await userWithToken('tw2@test.com');
    const universe = await createUniverse(hdrs);
    await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: { timelineWindow: { start: 1700, end: 2000 } },
    });
    const getRes = await req('GET', `/api/universes/${universe.id}`, { headers: hdrs });
    expect(getRes.status).toBe(200);
    const body = await json(getRes);
    expect(body.timelineWindow).toEqual({ start: 1700, end: 2000 });
  });

  it('PATCH /universes/:id with timelineWindow: null clears the window', async () => {
    const { hdrs } = await userWithToken('tw3@test.com');
    const universe = await createUniverse(hdrs);
    await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: { timelineWindow: { start: 0, end: 10 } },
    });
    const clearRes = await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: { timelineWindow: null },
    });
    expect(clearRes.status).toBe(200);
    const cleared = await json(clearRes);
    expect(cleared.timelineWindow).toBeNull();
  });

  it('PATCH /universes/:id rejects non-finite timelineWindow values (T-20-01)', async () => {
    const { hdrs } = await userWithToken('tw4@test.com');
    const universe = await createUniverse(hdrs);
    const res = await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: { timelineWindow: { start: 'not-a-number', end: 1 } },
    });
    // OpenAPIHono's Zod validator returns 400 on schema rejection.
    expect(res.status).toBe(400);
  });

  it('JSON export includes timelineWindow and import round-trips it', async () => {
    const { user, hdrs } = await userWithToken('tw5@test.com');
    const universe = await createUniverse(hdrs, 'OriginalWorld');
    await req('PATCH', `/api/universes/${universe.id}`, {
      headers: hdrs,
      body: { timelineWindow: { start: -50000, end: 2050 } },
    });

    // Load the raw export payload directly (D-07: exportUniverseJson now emits a
    // ZIP stream, so we go one seam lower to the in-memory payload) to avoid
    // pulling in the full /export route surface.
    const exported = await loadUniverseExportPayload(universe.id);
    expect(exported.universe.timelineWindow).toEqual({ start: -50000, end: 2050 });

    // Import as the SAME user (universe-name uniqueness isn't enforced at the
    // schema level, so this is safe). Use a slightly different name to make
    // the assertion target unambiguous. The payload carries no weltbon_version
    // (that key lives in the ZIP manifest), so supply it for importSchema.
    const importedSummary = await importUniverseJson(user.id, {
      ...exported,
      weltbon_version: '2.0.0',
      universe: { ...exported.universe, name: 'ImportedWorld' },
    });

    // Read the imported universe back via the route surface and confirm the window survived.
    const importedRes = await req('GET', `/api/universes/${importedSummary.universeId}`, { headers: hdrs });
    expect(importedRes.status).toBe(200);
    const importedUniverse = await json(importedRes);
    expect(importedUniverse.name).toBe('ImportedWorld');
    expect(importedUniverse.timelineWindow).toEqual({ start: -50000, end: 2050 });
  });

  it('import without a timelineWindow field defaults to null (pre-Phase-20 export compat)', async () => {
    const { user, hdrs } = await userWithToken('tw6@test.com');
    // Build a minimal v1.0.0 export-shaped payload WITHOUT a timelineWindow key.
    const legacyExport = {
      weltbon_version: '1.0.0',
      exported_at: new Date().toISOString(),
      universe: {
        name: 'LegacyWorld',
        description: '',
        entryTypes: ['concept'],
        // timelineWindow intentionally absent
      },
      categories: [],
      entries: [],
      links: [],
      issues: [],
      graphPositions: [],
      timelinePins: [],
    };
    const summary = await importUniverseJson(user.id, legacyExport);
    const res = await req('GET', `/api/universes/${summary.universeId}`, { headers: hdrs });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.timelineWindow).toBeNull();
  });
});
