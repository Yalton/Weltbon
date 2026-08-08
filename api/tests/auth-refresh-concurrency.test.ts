import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, type TestDbHandle } from './helpers.js';
import { refreshTokens, inviteCodes } from '../src/db/schema.js';
import { hashInviteToken } from '../src/services/invite.js';
import { REFRESH_GRACE_MS } from '../src/services/auth.js';

/**
 * Concurrent refresh-token rotation.
 *
 * Found by reproduction, not by reading: before this suite existed, two
 * concurrent refreshes of ONE cookie both returned 200 and minted TWO live
 * refresh tokens. `rotateRefreshToken`'s findFirst guarded on
 * `isNull(revokedAt)` but the UPDATE that revokes guarded only on `eq(id)`, so
 * under READ COMMITTED both transactions passed the read before either
 * committed — and the ~250ms `bcrypt.compare` between the two makes that window
 * very wide. Single-use rotation is the control that DETECTS a stolen refresh
 * token (the legitimate user's next refresh fails); minting two live tokens
 * defeated it silently.
 *
 * The contract now: the winner rotates, the loser gets an access token and NO
 * new refresh token, and a replay outside the grace window is refused.
 */
describe('concurrent refresh-token rotation', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);
    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  async function appRequest(
    method: string,
    path: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: { body?: any; headers?: Record<string, string> } = {}
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body) headers['Content-Type'] = 'application/json';
    const req = new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const res = await app.fetch(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    if (res.status !== 204) {
      try { json = await res.json(); } catch { /* no body */ }
    }
    return { status: res.status, body: json, setCookieHeader: res.headers.get('set-cookie') };
  }

  function extractRefreshCookie(setCookieHeader: string | null): string | null {
    if (!setCookieHeader) return null;
    const match = setCookieHeader.match(/refresh=([^;]+)/);
    return match ? match[1] : null;
  }

  async function registerAndGetCookie(): Promise<string> {
    await handle.db.insert(inviteCodes).values({
      hash: hashInviteToken('concurrency-invite-123'),
      bodySuffix: '123',
      label: 'concurrency',
      ownerId: null,
    });
    const reg = await appRequest('POST', '/api/auth/register', {
      body: {
        email: 'concurrent@example.com',
        password: 'concurrentpass123',
        displayName: 'Concurrent',
        inviteCode: 'concurrency-invite-123',
      },
    });
    expect(reg.status).toBe(200);
    const cookie = extractRefreshCookie(reg.setCookieHeader);
    expect(cookie).toBeTruthy();
    return cookie!;
  }

  it('two concurrent refreshes mint exactly ONE new refresh token, not two', async () => {
    const cookie = await registerAndGetCookie();

    const [a, b] = await Promise.all([
      appRequest('POST', '/api/auth/refresh', { headers: { Cookie: `refresh=${cookie}` } }),
      appRequest('POST', '/api/auth/refresh', { headers: { Cookie: `refresh=${cookie}` } }),
    ]);

    // Neither caller is signed out — that is the point of the grace window.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.accessToken).toBeTypeOf('string');
    expect(b.body.accessToken).toBeTypeOf('string');

    // THE ASSERTION THAT KILLS THE ORIGINAL BUG: exactly one live token.
    // Before the fix this was 2 — one single-use token yielding two live
    // successors. Restore the UPDATE's missing isNull(revokedAt) guard and
    // this is what fails.
    const rows = await handle.db.select().from(refreshTokens);
    const live = rows.filter((r) => r.revokedAt === null);
    expect(live.length).toBe(1);

    // Exactly one of the two responses rotates; the other sets no cookie at
    // all, so the browser keeps the winner's value.
    const cookiesSet = [a.setCookieHeader, b.setCookieHeader]
      .map(extractRefreshCookie)
      .filter(Boolean);
    expect(cookiesSet.length).toBe(1);
  });

  it('the surviving token still works afterwards, and the original is dead outside the grace window', async () => {
    const cookie = await registerAndGetCookie();

    const [a, b] = await Promise.all([
      appRequest('POST', '/api/auth/refresh', { headers: { Cookie: `refresh=${cookie}` } }),
      appRequest('POST', '/api/auth/refresh', { headers: { Cookie: `refresh=${cookie}` } }),
    ]);
    const survivor = extractRefreshCookie(a.setCookieHeader) ?? extractRefreshCookie(b.setCookieHeader);
    expect(survivor).toBeTruthy();

    // The rotated-to token is usable.
    const next = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${survivor}` },
    });
    expect(next.status).toBe(200);

    // Backdate the ORIGINAL token's revocation past the grace window, then
    // replay it. Backdating rather than sleeping keeps the test fast and makes
    // the boundary explicit instead of timing-dependent.
    const originalId = cookie.split('.')[0];
    await handle.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(Date.now() - REFRESH_GRACE_MS - 5_000) })
      .where(eq(refreshTokens.id, originalId));

    const replay = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${cookie}` },
    });
    expect(replay.status).toBe(401);
  });

  it('a replay inside the grace window grants an access token but NO refresh token', async () => {
    const cookie = await registerAndGetCookie();

    const first = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${cookie}` },
    });
    expect(first.status).toBe(200);

    const liveBefore = (await handle.db.select().from(refreshTokens))
      .filter((r) => r.revokedAt === null).length;

    // Immediate replay of the now-rotated token — the multi-tab shape.
    const replay = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${cookie}` },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.accessToken).toBeTypeOf('string');

    // No persistence is granted: the replay mints nothing and sets no cookie.
    // This is what keeps the grace window from being a replay loophole.
    expect(extractRefreshCookie(replay.setCookieHeader)).toBeNull();
    const liveAfter = (await handle.db.select().from(refreshTokens))
      .filter((r) => r.revokedAt === null).length;
    expect(liveAfter).toBe(liveBefore);
  });

  it('logout disqualifies the PREDECESSOR of the token being revoked (#14)', async () => {
    // The grace window keeps a concurrent tab from being signed out, but it must
    // not outlive an explicit logout. Before the fix, the check only looked at
    // the row logout itself revoked — so replaying the token that row was
    // ROTATED FROM still yielded a 1-hour access token after the user logged
    // out, and revokeAllForUser could not reach it either (it filters
    // isNull(revokedAt), so it never touches an already-rotated row).
    const a = await registerAndGetCookie();

    // Rotate A -> B. A is now revoked with replacedById set: grace-eligible.
    const rotate = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${a}` },
    });
    expect(rotate.status).toBe(200);
    const b = extractRefreshCookie(rotate.setCookieHeader);
    expect(b).toBeTruthy();

    // Sanity: A is inside its grace window right now, so without the logout
    // below it WOULD be honoured. This is what makes the assertion meaningful
    // rather than passing because the window had simply expired.
    const beforeLogout = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${a}` },
    });
    expect(beforeLogout.status).toBe(200);

    await appRequest('POST', '/api/auth/logout', { headers: { Cookie: `refresh=${b}` } });

    // The predecessor must now be refused, still well inside the 10s window.
    const replay = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${a}` },
    });
    expect(replay.status).toBe(401);
  });

  it('a password change (revokeAllForUser) also disqualifies rotated predecessors (#14)', async () => {
    const a = await registerAndGetCookie();
    const rotate = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${a}` },
    });
    expect(rotate.status).toBe(200);

    const [row] = await handle.db.select().from(refreshTokens).limit(1);
    const { revokeAllForUser } = await import('../src/services/auth.js');
    await revokeAllForUser(row.userId, handle.db as never);

    const replay = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: `refresh=${a}` },
    });
    expect(replay.status).toBe(401);
  });

  it('an unknown token is still refused', async () => {
    // A well-formed but unknown id. NOT a malformed one: a non-UUID id reaches
    // a uuid column and the route currently 500s instead of 401ing. That is a
    // real pre-existing robustness bug, but it is not this fix's subject, so it
    // is recorded in docs/open-items/ rather than folded in here.
    const bad = await appRequest('POST', '/api/auth/refresh', {
      headers: { Cookie: 'refresh=00000000-0000-4000-8000-000000000000.nosuchsecret' },
    });
    expect(bad.status).toBe(401);
  });
});
