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
import { buildPublicUrl } from '../src/middleware/forwarded.js';
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
});
