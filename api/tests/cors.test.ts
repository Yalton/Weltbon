/**
 * CORS behavior tests (PROXY-01).
 *
 * Verifies CONTEXT.md §"CORS":
 *   - WELTBON_PUBLIC_ORIGIN unset → preserves (o) => o reflect-all dev behavior
 *   - WELTBON_PUBLIC_ORIGIN set + Origin matches → echoes the configured origin
 *   - WELTBON_PUBLIC_ORIGIN set + Origin mismatches → no Access-Control-Allow-Origin
 *
 * The cfg singleton is loaded lazily at first env() call (api/src/config.ts:43-46).
 * We use vi.resetModules() between describe blocks to force a fresh load with
 * different WELTBON_PUBLIC_ORIGIN values. NO DB needed (CORS is route-independent).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

/** Issues an OPTIONS preflight against /api/openapi.json. */
async function preflight(app: any, origin: string) {
  const res = await app.fetch(new Request('http://localhost/api/openapi.json', {
    method: 'OPTIONS',
    headers: {
      'Origin': origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  }));
  return res;
}

describe('CORS conditional-strict origin (PROXY-01)', () => {
  describe('WELTBON_PUBLIC_ORIGIN UNSET — preserves dev (o) => o reflect-all', () => {
    let app: any;
    const originalPublicOrigin = process.env.WELTBON_PUBLIC_ORIGIN;

    beforeAll(async () => {
      delete process.env.WELTBON_PUBLIC_ORIGIN;
      vi.resetModules();
      const indexModule = await import('../src/index.js');
      app = indexModule.createApp();
    });

    afterAll(() => {
      if (originalPublicOrigin === undefined) delete process.env.WELTBON_PUBLIC_ORIGIN;
      else process.env.WELTBON_PUBLIC_ORIGIN = originalPublicOrigin;
    });

    it('Test 1: preflight with Origin: http://localhost:5173 echoes that origin back', async () => {
      const res = await preflight(app, 'http://localhost:5173');
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });
  });

  describe('WELTBON_PUBLIC_ORIGIN=https://welt.example.com — strict single-origin', () => {
    let app: any;
    const originalPublicOrigin = process.env.WELTBON_PUBLIC_ORIGIN;

    beforeAll(async () => {
      process.env.WELTBON_PUBLIC_ORIGIN = 'https://welt.example.com';
      vi.resetModules();
      const indexModule = await import('../src/index.js');
      app = indexModule.createApp();
    });

    afterAll(() => {
      if (originalPublicOrigin === undefined) delete process.env.WELTBON_PUBLIC_ORIGIN;
      else process.env.WELTBON_PUBLIC_ORIGIN = originalPublicOrigin;
    });

    it('Test 2: preflight from the configured origin returns Access-Control-Allow-Origin: https://welt.example.com', async () => {
      const res = await preflight(app, 'https://welt.example.com');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://welt.example.com');
    });

    it('Test 3: preflight from a different origin returns NO Access-Control-Allow-Origin header (and never the wildcard)', async () => {
      const res = await preflight(app, 'https://evil.example.com');
      const allowOrigin = res.headers.get('access-control-allow-origin');
      expect(allowOrigin).toBeNull();
      // Defense in depth — guard against future Hono cors changes that fall back to '*'
      expect(allowOrigin).not.toBe('*');
    });
  });

  describe('WELTBON_PUBLIC_ORIGIN=http://127.0.0.1 (desktop mode, no port) — no real browser Origin ever matches', () => {
    // Review round 1, Finding 1 (SECURITY): desktop/src/main.ts sets this to
    // block the cross-origin token-theft path — a page at evil.example
    // fetching POST /api/auth/local-session and reading the bearer token out
    // of the response body. A real browser's Origin header ALWAYS carries
    // the port (Electron's window loads http://127.0.0.1:<ephemeral port>),
    // so 'http://127.0.0.1' (no port) is a value no genuine Origin can equal
    // — this proves that property, not just the general PROXY-01 mismatch
    // case Test 3 above already covers with a different-host origin.
    let app: any;
    const originalPublicOrigin = process.env.WELTBON_PUBLIC_ORIGIN;

    beforeAll(async () => {
      process.env.WELTBON_PUBLIC_ORIGIN = 'http://127.0.0.1';
      vi.resetModules();
      const indexModule = await import('../src/index.js');
      app = indexModule.createApp();
    });

    afterAll(() => {
      if (originalPublicOrigin === undefined) delete process.env.WELTBON_PUBLIC_ORIGIN;
      else process.env.WELTBON_PUBLIC_ORIGIN = originalPublicOrigin;
    });

    it('a same-host Origin WITH a port (what every real browser sends) gets no Access-Control-Allow-Origin', async () => {
      const res = await preflight(app, 'http://127.0.0.1:54321');
      const allowOrigin = res.headers.get('access-control-allow-origin');
      expect(allowOrigin).toBeNull();
      expect(allowOrigin).not.toBe('*');
    });

    it('a different host entirely (the evil.example attack) also gets no Access-Control-Allow-Origin', async () => {
      const res = await preflight(app, 'https://evil.example.com');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('same-origin requests are unaffected — GET /health still works with no Origin header at all', async () => {
      const res = await app.fetch(new Request('http://localhost/health'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe('Non-CORS routes still function', () => {
    let app: any;

    beforeAll(async () => {
      vi.resetModules();
      const indexModule = await import('../src/index.js');
      app = indexModule.app;
    });

    it('Test 4: GET /health returns 200 (no Origin header, no CORS dance)', async () => {
      const res = await app.fetch(new Request('http://localhost/health'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });
});
