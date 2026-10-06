import { describe, expect, it } from 'vitest';
import { COLD_START_TIMEOUT } from './helpers/timeouts.js';

/**
 * Hardening headers on every response, API and web alike. HSTS is
 * deliberately not set here: it belongs on the TLS-terminating proxy.
 */
function csp(res: Response): Map<string, string[]> {
  const header = res.headers.get('content-security-policy') ?? '';
  return new Map(
    header.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const [name, ...values] = d.split(/\s+/);
      return [name, values] as const;
    }),
  );
}

describe('security headers', { timeout: COLD_START_TIMEOUT }, () => {
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

  it('sends a Content-Security-Policy that only runs scripts the app itself serves', async () => {
    const { createApp } = await import('../src/index.js');
    const res = await createApp().request('/api/runtime');
    const policy = csp(res);

    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('script-src')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'self'"]);
    // Entries can embed images from any site, and exports use blob: URLs.
    expect(policy.get('img-src')).toEqual(expect.arrayContaining(['data:', 'blob:', 'https:']));
  });

  it('lets only the API reference page load its renderer from the CDN', async () => {
    const { createApp } = await import('../src/index.js');
    const app = createApp();

    const docs = csp(await app.request('/api/docs'));
    expect(docs.get('script-src')).toEqual(["'self'", 'https://cdn.jsdelivr.net']);
    expect(docs.get('object-src')).toEqual(["'none'"]);
    expect(docs.get('frame-ancestors')).toEqual(["'self'"]);

    const app2 = csp(await app.request('/api/runtime'));
    expect(app2.get('script-src')).not.toContain('https://cdn.jsdelivr.net');
  });
});
