import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(resolve(here, `fixtures/ollama/${n}.json`), 'utf8'));

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/show')) {
      const body = init?.body ? (JSON.parse(init.body as string) as { model?: string }) : {};
      const key = `/api/show:${body.model ?? ''}`;
      if (!(key in routes)) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(routes[key]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('llm-connections routes', () => {
  let handle: TestDbHandle;
  // Hono's own request() return type is `Response | Promise<Response>`, and
  // createApp()'s concrete Hono<...> generic instantiation is unwieldy to
  // spell out here — mirrors tests/auth.test.ts's identical `any` + disable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let token: string;

  async function boot(localMode: boolean, encryptionKey?: string) {
    if (localMode) process.env.WELTBON_LOCAL_MODE = '1';
    else delete process.env.WELTBON_LOCAL_MODE;
    if (encryptionKey) process.env.LLM_KEY_ENCRYPTION_KEY = encryptionKey;
    else delete process.env.LLM_KEY_ENCRYPTION_KEY;

    const { _resetEnvForTests } = await import('../src/config.js');
    _resetEnvForTests();
    const { createApp } = await import('../src/index.js');
    app = createApp();
  }

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db, handle.pool);
  });

  afterAll(async () => {
    delete process.env.WELTBON_LOCAL_MODE;
    delete process.env.LLM_KEY_ENCRYPTION_KEY;
    await cleanDb(handle);
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const user = await createTestUser(handle, { email: 'conn@test.dev', password: 'password12345' });
    const { issueAccessToken } = await import('../src/services/auth.js');
    token = await issueAccessToken(user.id);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Desktop-only enforcement ─────────────────────────────────────────────

  it('rejects writing a connection when localMode is OFF', async () => {
    // Hosted instances must not accept a user-supplied endpoint at all. This is
    // the whole desktop-only restriction; a hidden UI control is not enforcement.
    await boot(false);
    const res = await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434' }),
    });
    expect([403, 404]).toContain(res.status);
  });

  it('re-checks localMode inside every handler, not only at route registration (spec D-5 layer 2)', async () => {
    // Spec D-5 requires TWO independent layers because layer 1 can break: a
    // future refactor that mounts the router unconditionally, or a test/dev
    // harness that builds the app once and reuses it, silently removes it.
    //

    // tests all call boot(false), so the router is never mounted and the 404
    // they get satisfies `expect([403, 404]).toContain(...)`. Deleting all
    // five `if (!env().localMode) ... 403` handler guards left the whole suite
    // green — layer 2 had no coverage of its own at all.
    //
    // This test boots ON (router mounted, layer 1 satisfied) and then flips
    // the flag WITHOUT rebuilding the app, so the routes stay registered and
    // the only thing that can produce a 403 is the handler's own live re-check
    // (`env()` read at call time, never captured at module scope — the
    // routes/auth.ts DV-11 pattern). A 404 here would mean the request never
    // reached a handler and the assertion would be testing layer 1 again;
    // hence `toBe(403)`, never `toContain`.
    await boot(true);
    // Liveness probe: a PUT that actually succeeds. A GET would 404 here for
    // the mundane reason that no row exists yet — indistinguishable from the
    // router not being mounted, which is the exact confusion this test exists
    // to remove.
    const live = await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434' }),
    });
    expect(live.status).toBe(200); // layer 1 is satisfied: the router IS mounted

    delete process.env.WELTBON_LOCAL_MODE;
    const { _resetEnvForTests } = await import('../src/config.js');
    _resetEnvForTests();

    // All five handlers, because all five carry their own guard and any one of
    // them left unguarded is a hosted instance accepting a user-supplied
    // endpoint (the SSRF shape the desktop-only rule exists to avoid).
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/api/llm-connections/ollama'],
      ['PUT', '/api/llm-connections/ollama', { baseUrl: 'http://box:11434' }],
      ['DELETE', '/api/llm-connections/ollama'],
      ['POST', '/api/llm-connections/ollama/test'],
      ['GET', '/api/llm-connections/ollama/models'],
    ];
    for (const [method, path, body] of cases) {
      const init: RequestInit = { method, headers: { ...authHeader(token) } };
      if (body !== undefined) {
        (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await app.request(path, init);
      expect(res.status, `${method} ${path} must 403 from its own handler guard`).toBe(403);
    }
  });

  it('accepts and reads back a connection when localMode is ON', async () => {
    await boot(true);
    const put = await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434', label: 'Home' }),
    });
    expect(put.status).toBe(200);
    const get = await app.request('/api/llm-connections/ollama', { headers: authHeader(token) });
    expect((await get.json()).baseUrl).toBe('http://box:11434');
  });

  it('reports localMode through GET /api/config so the shared frontend can branch', async () => {
    await boot(true);
    const res = await app.request('/api/config', { headers: authHeader(token) });
    expect((await res.json()).localMode).toBe(true);
  });

  it('GET /api/config reports localMode: false when off — round-trips both directions, not just the ON case', async () => {
    await boot(false);
    const res = await app.request('/api/config', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    expect((await res.json()).localMode).toBe(false);
  });

  it('GET /api/config requires authentication', async () => {
    await boot(true);
    const res = await app.request('/api/config');
    expect(res.status).toBe(401);
  });

  it('requires authentication', async () => {
    await boot(true);
    const res = await app.request('/api/llm-connections/ollama');
    expect(res.status).toBe(401);
  });

  // ── CRUD ──────────────────────────────────────────────────────────────────

  it('GET 404s when no connection is configured', async () => {
    await boot(true);
    const res = await app.request('/api/llm-connections/ollama', { headers: authHeader(token) });
    expect(res.status).toBe(404);
  });

  it('masks a stored secret to bodySuffix and never echoes the plaintext', async () => {
    await boot(true, 'a'.repeat(64));
    const put = await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434', secret: 'proxy-token-xyz' }),
    });
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(body.bodySuffix).toBe('-xyz');
    // The mask invariant: the plaintext must never appear anywhere in the response.
    expect(JSON.stringify(body)).not.toContain('proxy-token-xyz');
  });

  it('refuses a secret it cannot encrypt (503) rather than silently dropping it — no row is written', async () => {

    // upsertConnection would write the row with the secret simply gone and no
    // error anywhere; this pins the caller-visible 503 AND that nothing was
    // written, so a retry-without-noticing scenario cannot leave a
    // secret-less connection masquerading as configured.
    await boot(true);
    const put = await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434', secret: 'proxy-token-xyz' }),
    });
    expect(put.status).toBe(503);
    const get = await app.request('/api/llm-connections/ollama', { headers: authHeader(token) });
    expect(get.status).toBe(404);
  });

  it('DELETE removes the connection; a second DELETE 404s', async () => {
    await boot(true);
    await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434' }),
    });
    const del1 = await app.request('/api/llm-connections/ollama', { method: 'DELETE', headers: authHeader(token) });
    expect(del1.status).toBe(204);
    const del2 = await app.request('/api/llm-connections/ollama', { method: 'DELETE', headers: authHeader(token) });
    expect(del2.status).toBe(404);
  });

  // ── POST /test ────────────────────────────────────────────────────────────

  it('POST /test reaches a fake reachable server and advances lastValidatedAt', async () => {
    await boot(true);
    await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434' }),
    });
    // OllamaProvider.validate() (providers/llm/ollama.ts) always uses the
    // global `fetch` — it has no injectable fetchImpl parameter (unlike
    // listOllamaModels), so stubbing the global is the only way to exercise
    // this route without a real network call.
    vi.stubGlobal('fetch', fakeFetch({ '/api/tags': { models: [] } }));
    const res = await app.request('/api/llm-connections/ollama/test', { method: 'POST', headers: authHeader(token) });
    expect(res.status).toBe(200);
    expect((await res.json()).lastValidatedAt).toEqual(expect.any(String));

    const get = await app.request('/api/llm-connections/ollama', { headers: authHeader(token) });
    expect((await get.json()).lastValidatedAt).toEqual(expect.any(String));
  });

  it('POST /test surfaces an unreachable server as 503, not a crash', async () => {
    await boot(true);
    await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434' }),
    });
    vi.stubGlobal('fetch', (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    const res = await app.request('/api/llm-connections/ollama/test', { method: 'POST', headers: authHeader(token) });
    expect(res.status).toBe(503);
  });

  it('POST /test 404s when no connection is configured', async () => {
    await boot(true);
    const res = await app.request('/api/llm-connections/ollama/test', { method: 'POST', headers: authHeader(token) });
    expect(res.status).toBe(404);
  });

  // ── GET /models ───────────────────────────────────────────────────────────

  it('GET /models live-discovers installed models, marking a tools-capable model usable and a vision-only model not', async () => {
    // This is the exact scenario Step 5 exists to unblock: a saved connection
    // must be able to list real installed models, not an empty stub — proven
    // here end-to-end through the HTTP surface, not just at the listOllamaModels
    // unit level (tests/llm-ollama.test.ts already covers that).
    await boot(true);
    await app.request('/api/llm-connections/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({ baseUrl: 'http://box:11434' }),
    });
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/tags': { models: [{ name: 'qwen3:32b' }, { name: 'llava:latest' }] },
        '/api/show:qwen3:32b': fx('show-qwen3-32b'),
        '/api/show:llava:latest': fx('show-llava'),
      }),
    );
    const res = await app.request('/api/llm-connections/ollama/models', { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const models = (await res.json()) as Array<{ name: string; supportsTools: boolean }>;
    expect(models.find((m) => m.name === 'qwen3:32b')?.supportsTools).toBe(true);
    expect(models.find((m) => m.name === 'llava:latest')?.supportsTools).toBe(false);
  });

  it('GET /models 404s when no connection is configured', async () => {
    await boot(true);
    const res = await app.request('/api/llm-connections/ollama/models', { headers: authHeader(token) });
    expect(res.status).toBe(404);
  });
});
