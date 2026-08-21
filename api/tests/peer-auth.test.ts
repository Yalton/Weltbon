import { describe, it, expect } from 'vitest';
import { mintPatFromCredentials, PeerAuthError } from '../src/services/sync/peer-auth';

/**
 * A fetch double that answers the two peer endpoints in sequence.
 *
 * Shapes verified against src/routes/auth.ts and src/routes/tokens.ts:
 *   login  -> 200 { accessToken, user }  (not `{ token }`)
 *   tokens -> 200 { ..., plaintext }     (not `{ token }`, not 201)
 */
function fakePeer(opts: { loginStatus?: number; tokenStatus?: number; pat?: string } = {}) {
  const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
    });
    if (u.endsWith('/api/auth/login')) {
      const status = opts.loginStatus ?? 200;
      return new Response(
        status === 200
          ? JSON.stringify({ accessToken: 'peer-jwt', user: { id: '1', email: 'me@example.com', displayName: 'Me' } })
          : JSON.stringify({ error: 'Invalid credentials' }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (u.endsWith('/api/auth/tokens')) {
      const status = opts.tokenStatus ?? 200;
      return new Response(
        JSON.stringify({
          id: 'tok_1',
          label: 'Desktop',
          bodySuffix: 'abc123',
          createdAt: new Date().toISOString(),
          plaintext: opts.pat ?? 'wbn_pat_abc123',
        }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('mintPatFromCredentials', () => {
  it('logs in, mints with the JWT, and returns the PAT', async () => {
    const peer = fakePeer();
    const pat = await mintPatFromCredentials({
      baseUrl: 'https://peer.example',
      email: 'me@example.com',
      password: 'hunter2',
      label: 'Desktop',
      fetchImpl: peer.impl,
    });

    expect(pat).toBe('wbn_pat_abc123');
    expect(peer.calls[0].url).toBe('https://peer.example/api/auth/login');
    expect(peer.calls[0].body).toEqual({ email: 'me@example.com', password: 'hunter2' });
    expect(peer.calls[1].url).toBe('https://peer.example/api/auth/tokens');
    expect(peer.calls[1].body).toEqual({ label: 'Desktop' });
    expect(peer.calls[1].auth).toBe('Bearer peer-jwt');
  });

  it('maps a rejected login to a 401 PeerAuthError and does not attempt to mint', async () => {
    const peer = fakePeer({ loginStatus: 401 });
    await expect(
      mintPatFromCredentials({
        baseUrl: 'https://peer.example', email: 'me@example.com',
        password: 'wrong', label: 'Desktop', fetchImpl: peer.impl,
      }),
    ).rejects.toMatchObject({ code: 'peer_credentials_rejected', status: 401 });
    expect(peer.calls).toHaveLength(1);
  });

  it('maps a transport failure to peer_unreachable (502)', async () => {
    const impl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(
      mintPatFromCredentials({
        baseUrl: 'https://peer.example', email: 'a@b.c',
        password: 'x', label: 'Desktop', fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: 'peer_unreachable', status: 502 });
  });

  it('maps a non-Weltbon response shape to peer_not_weltbon (502)', async () => {
    const impl = (async () =>
      new Response('<html>hello</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
    ) as unknown as typeof fetch;
    await expect(
      mintPatFromCredentials({
        baseUrl: 'https://peer.example', email: 'a@b.c',
        password: 'x', label: 'Desktop', fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: 'peer_not_weltbon', status: 502 });
  });

  it('never puts the password in the error message', async () => {
    const peer = fakePeer({ loginStatus: 401 });
    const err = await mintPatFromCredentials({
      baseUrl: 'https://peer.example', email: 'me@example.com',
      password: 'super-secret-pw', label: 'Desktop', fetchImpl: peer.impl,
    }).catch((e: PeerAuthError) => e);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('super-secret-pw');
  });
});
