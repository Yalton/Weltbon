/**
 * Behavioral tests for the forwarded middleware + buildPublicUrl helper (PROXY-02).
 *
 * Verifies CONTEXT.md §"Trust-proxy / X-Forwarded handling":
 *   - Always honor X-Forwarded-Proto / X-Forwarded-Host when present
 *   - Fall back to in-container Host header + 'http' scheme when absent
 *   - Acceptance criterion 2: 'https://welt.example.com' resolves correctly
 *
 * Pure-helper tests use a hand-rolled Context-shaped fake (no DB, no createApp).
 * The single mount test imports app from src/index.js directly (no DB needed —
 * GET /health doesn't touch the database).
 */

import { describe, it, expect } from 'vitest';
import { buildPublicUrl, clientIp } from '../src/middleware/forwarded.js';
import { app } from '../src/index.js';

/** Minimal Context-shaped fake: only the header() method buildPublicUrl uses. */
function fakeContext(headers: Record<string, string | undefined>) {
  return {
    req: {
      header: (name: string) => headers[name],
    },
  } as any;
}

describe('forwarded middleware + buildPublicUrl (PROXY-02)', () => {
  describe('buildPublicUrl(c) — precedence rules', () => {
    it('Test 1: uses X-Forwarded-Proto from header when present', () => {
      const url = buildPublicUrl(fakeContext({ 'X-Forwarded-Proto': 'https', 'Host': 'in-container:3000' }));
      expect(url.startsWith('https://')).toBe(true);
    });

    it('Test 2: uses X-Forwarded-Host from header when present', () => {
      const url = buildPublicUrl(fakeContext({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'welt.example.com' }));
      expect(url).toContain('welt.example.com');
    });

    it('Test 3: falls back to http scheme when X-Forwarded-Proto is absent', () => {
      const url = buildPublicUrl(fakeContext({ 'Host': 'in-container:3000' }));
      expect(url.startsWith('http://')).toBe(true);
      expect(url.startsWith('https://')).toBe(false);
    });

    it('Test 4: falls back to Host header when X-Forwarded-Host is absent', () => {
      const url = buildPublicUrl(fakeContext({ 'Host': 'in-container:3000' }));
      expect(url).toContain('in-container:3000');
    });

    it('Test 5: falls back to "localhost" when both X-Forwarded-Host and Host are absent', () => {
      const url = buildPublicUrl(fakeContext({}));
      expect(url).toBe('http://localhost');
    });

    it('Test 6: appends the optional path argument', () => {
      const url = buildPublicUrl(
        fakeContext({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'welt.example.com' }),
        '/api/foo'
      );
      expect(url).toBe('https://welt.example.com/api/foo');
    });

    it('Test 7: combines X-Forwarded-Proto + X-Forwarded-Host into the full proxied origin (PROXY-02 success criterion)', () => {
      const url = buildPublicUrl(fakeContext({
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'welt.example.com',
      }));
      expect(url).toBe('https://welt.example.com');
    });
  });

  describe('forwarded middleware mounted in createApp() — does not break existing routes', () => {
    it('Test 8: GET /health still returns 200 with X-Forwarded-* headers set', async () => {

      // Pre-14-05, the middleware exists but is not yet mounted; the route still
      // returns 200 because GET /health is independent of the middleware chain.
      const res = await app.fetch(new Request('http://localhost/health', {
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'welt.example.com',
        },
      }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe('clientIp(c) — rate-limit key', () => {
    function ctx(headers: Record<string, string | undefined>, remoteAddress?: string) {
      return {
        req: { header: (name: string) => headers[name] },
        env: remoteAddress === undefined ? {} : { incoming: { socket: { remoteAddress } } },
      } as any;
    }

    describe('behind a trusted proxy (WELTBON_TRUST_PROXY=true)', () => {
      const trusted = { trustProxy: true };

      it('uses the right-most X-Forwarded-For entry, the one the nearest proxy appended', () => {
        expect(clientIp(ctx({ 'X-Forwarded-For': '6.6.6.6, 203.0.113.7' }, '172.18.0.2'), trusted)).toBe('203.0.113.7');
      });

      it('trims whitespace and skips empty trailing entries', () => {
        expect(clientIp(ctx({ 'X-Forwarded-For': ' 203.0.113.7 , ' }), trusted)).toBe('203.0.113.7');
      });
    });

    describe('exposed directly (WELTBON_TRUST_PROXY unset)', () => {
      const direct = { trustProxy: false };

      it('ignores a client-supplied X-Forwarded-For and keys on the socket peer', () => {
        expect(clientIp(ctx({ 'X-Forwarded-For': '203.0.113.7' }, '198.51.100.4'), direct)).toBe('198.51.100.4');
      });

      it('gives every spoofed X-Forwarded-For from one peer the same key', () => {
        const keys = ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((ip) =>
          clientIp(ctx({ 'X-Forwarded-For': ip }, '198.51.100.4'), direct));
        expect(new Set(keys)).toEqual(new Set(['198.51.100.4']));
      });
    });

    it('falls back to the socket peer when no X-Forwarded-For is present', () => {
      expect(clientIp(ctx({}, '198.51.100.4'), { trustProxy: true })).toBe('198.51.100.4');
    });

    it('returns "unknown" when neither is available (e.g. app.request in tests)', () => {
      expect(clientIp(ctx({}), { trustProxy: false })).toBe('unknown');
    });
  });
});
