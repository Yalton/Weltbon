import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { api } from './client';

/**
 * Tests cover the FormData branch added by Plan 12-02 plus the JSON branch
 * to guard against accidental regression. Plan 12-06's multipart upload
 * relies on the browser setting the multipart boundary itself; if api()
 * forces `application/json` the server can't parse the request.
 */
describe('api() helper — Content-Type negotiation', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('does NOT set Content-Type when the body is FormData (browser-managed boundary)', async () => {
    const fd = new FormData();
    fd.append('files', new Blob(['hello'], { type: 'text/markdown' }), 'a.md');

    await api('/some-path', { method: 'POST', body: fd });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers).toBeDefined();
    expect(headers['Content-Type']).toBeUndefined();
    // Body identity preserved.
    expect(init.body).toBe(fd);
  });

  it('keeps the existing application/json default when body is a string', async () => {
    await api('/some-path', { method: 'POST', body: JSON.stringify({ x: 1 }) });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('keeps the application/json default when body is undefined (GET, etc.)', async () => {
    await api('/some-path');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('caller can still override Content-Type via init.headers (FormData branch)', async () => {
    const fd = new FormData();
    await api('/some-path', {
      method: 'POST',
      body: fd,
      headers: { 'X-Trace': 'test' },
    });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers['X-Trace']).toBe('test');
  });
});
