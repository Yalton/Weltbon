import { describe, expect, it } from 'vitest';

/**
 * Baseline hardening headers on every response, API and web alike. A
 * Content-Security-Policy and HSTS are deliberately not set here: CSP needs an
 * audit of the app's inline script and the /api/docs CDN, and HSTS belongs on
 * the TLS-terminating proxy.
 */
describe('security headers', () => {
  it('sets nosniff, a referrer policy and same-origin framing on every response', async () => {
    const { createApp } = await import('../src/index.js');
    const app = createApp();
    for (const path of ['/api/runtime', '/health']) {
      const res = await app.request(path);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('x-frame-options'), path).toBe('SAMEORIGIN');
      expect(res.headers.get('cross-origin-embedder-policy'), path).toBeNull();
      expect(res.headers.get('cross-origin-resource-policy'), path).toBeNull();
    }
  });
});
