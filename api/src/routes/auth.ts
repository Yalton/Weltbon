import { Hono } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { users, inviteCodes } from '../db/schema.js';
import { requireAuth, type AuthVariables } from '../middleware/auth.js';
import {
  hashPassword,
  verifyPassword,
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  REFRESH_COOKIE_NAME,
  REFRESH_TTL_MS,
} from '../services/auth.js';

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(80),
  inviteCode: z.string().min(1).max(64),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const REFRESH_TTL_SECONDS = Math.floor(REFRESH_TTL_MS / 1000);

function setRefreshCookie(c: any, token: string) {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/auth',
    maxAge: REFRESH_TTL_SECONDS,
    // secure: true in production; left off so LAN HTTP works (documented in README)
  });
}

export const authRoutes = new Hono<{ Variables: AuthVariables }>()
  .post('/register', zValidator('json', registerSchema), async (c) => {
    const { email, password, displayName, inviteCode } = c.req.valid('json');

    // 1. Consume invite code atomically (only succeeds if unused)
    const consumed = await getDb()
      .update(inviteCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(inviteCodes.code, inviteCode), isNull(inviteCodes.usedAt)))
      .returning();
    if (consumed.length === 0) {
      return c.json({ error: 'Invalid or used invite code' }, 400);
    }

    // 2. Create user
    try {
      const passwordHash = await hashPassword(password);
      const [user] = await getDb()
        .insert(users)
        .values({ email, displayName, passwordHash })
        .returning({ id: users.id, email: users.email, displayName: users.displayName });

      // 3. Link invite -> user
      await getDb()
        .update(inviteCodes)
        .set({ usedByUserId: user.id })
        .where(eq(inviteCodes.code, inviteCode));

      // 4. Issue tokens
      const accessToken = await issueAccessToken(user.id);
      const refreshToken = await issueRefreshToken(user.id);
      setRefreshCookie(c, refreshToken);

      return c.json({ accessToken, user }, 200);
    } catch (err: any) {
      // If user creation failed (e.g. duplicate email), the invite was burned.
      // This is acceptable: operator issues a new one. Alternative is a transaction; keeping simple for v1.
      if (err?.code === '23505') {
        return c.json({ error: 'Email already registered' }, 400);
      }
      throw err;
    }
  })

  .post('/login', zValidator('json', loginSchema), async (c) => {
    const { email, password } = c.req.valid('json');
    const user = await getDb().query.users.findFirst({ where: eq(users.email, email) });
    // Single 401 message regardless of "no user" vs "wrong password" -- avoid user enumeration
    if (!user) {
      // Constant-time delay to avoid timing-based user enumeration
      await verifyPassword(password, '$2b$12$' + 'x'.repeat(53));
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    const accessToken = await issueAccessToken(user.id);
    const refreshToken = await issueRefreshToken(user.id);
    setRefreshCookie(c, refreshToken);
    return c.json({
      accessToken,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    }, 200);
  })

  .post('/refresh', async (c) => {
    const cookie = getCookie(c, REFRESH_COOKIE_NAME);
    if (!cookie) return c.json({ error: 'No refresh token' }, 401);
    const rotated = await rotateRefreshToken(cookie);
    if (!rotated) {
      deleteCookie(c, REFRESH_COOKIE_NAME, { path: '/auth' });
      return c.json({ error: 'Invalid refresh token' }, 401);
    }
    const accessToken = await issueAccessToken(rotated.userId);
    setRefreshCookie(c, rotated.newToken);
    return c.json({ accessToken }, 200);
  })

  .post('/logout', async (c) => {
    const cookie = getCookie(c, REFRESH_COOKIE_NAME);
    if (cookie) {
      await revokeRefreshToken(cookie);
    }
    deleteCookie(c, REFRESH_COOKIE_NAME, { path: '/auth' });
    return c.body(null, 204);
  })

  // GET /auth/me -- returns the current user (protected by requireAuth)
  // Used by the web client's ProtectedRoute after cold-load silent refresh
  // so the user identity is rehydrated into the in-memory auth store.
  .get('/me', requireAuth, async (c) => {
    const userId = c.var.userId;
    const user = await getDb().query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true, displayName: true },
    });
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json(user);
  });
