import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
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
import { hashInviteToken } from '../services/invite.js';

type AppEnv = { Variables: AuthVariables };

// ─── Zod schemas ────────────────────────────────────────────────────────────

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

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
});

// /auth/me response includes llmConsentedAt so the web client can render
// the consent gate on /settings/llm without a separate fetch (Phase 22-05).
const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  llmConsentedAt: z.string().nullable(),
});

const authResponseSchema = z.object({
  accessToken: z.string(),
  user: userSchema,
});

const refreshResponseSchema = z.object({
  accessToken: z.string(),
});

const errorSchema = z.object({
  error: z.string(),
});

const REFRESH_TTL_SECONDS = Math.floor(REFRESH_TTL_MS / 1000);

// Cookie path must prefix the URL where the cookie is sent back. The auth
// router is mounted at /api/auth in index.ts, so the cookie path must be
// /api/auth — not /auth — or the browser will silently drop it on every
// refresh attempt and the user will appear logged out on every page reload.
const REFRESH_COOKIE_PATH = '/api/auth';

function setRefreshCookie(c: any, token: string) {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TTL_SECONDS,
    // secure: true in production; left off so LAN HTTP works (documented in README)
  });
}

// ─── Route definitions ───────────────────────────────────────────────────────

const registerRoute = createRoute({
  method: 'post',
  path: '/register',
  tags: ['Auth'],
  summary: 'Register a new user',
  description: 'Creates a new user account. Requires a valid invite code.',
  security: [],
  request: {
    body: {
      content: {
        'application/json': {
          schema: registerSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: authResponseSchema,
        },
      },
      description: 'User registered; JWT access token issued; refresh token set as HTTP-only cookie',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid or used invite code (collapses duplicate-email per D-INV-11 to prevent enumeration)',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const loginRoute = createRoute({
  method: 'post',
  path: '/login',
  tags: ['Auth'],
  summary: 'Log in',
  description: 'Authenticates a user. Returns a JWT access token and sets a refresh token cookie.',
  security: [],
  request: {
    body: {
      content: {
        'application/json': {
          schema: loginSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: authResponseSchema,
        },
      },
      description: 'Authenticated; JWT access token issued; refresh token set as HTTP-only cookie',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Invalid credentials',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/refresh',
  tags: ['Auth'],
  summary: 'Refresh access token',
  description: 'Exchanges a valid refresh token cookie for a new JWT access token. Rotates the refresh token (single-use).',
  security: [],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: refreshResponseSchema,
        },
      },
      description: 'New access token issued; refresh token rotated',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing, expired, or invalid refresh token cookie',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const logoutRoute = createRoute({
  method: 'post',
  path: '/logout',
  tags: ['Auth'],
  summary: 'Log out',
  description: 'Revokes the refresh token cookie and clears it. No bearer token required.',
  security: [],
  responses: {
    204: {
      description: 'Logged out; refresh token revoked',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Auth'],
  summary: 'Get current user',
  description: 'Returns the authenticated user\'s profile. Used by the web client after cold-load silent refresh.',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: {
      content: {
        'application/json': {
          schema: meResponseSchema,
        },
      },
      description: 'Current user profile (includes llmConsentedAt for Phase 22 BYOK)',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Missing or invalid bearer token',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'User not found (deleted after token issuance)',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const authRoutes = new OpenAPIHono<AppEnv>()

  .openapi(registerRoute, async (c) => {
    const { email, password, displayName, inviteCode } = c.req.valid('json');

    // Consume invite + create user + link in one transaction. Any failure
    // (invalid invite, duplicate email, transient DB error) rolls back the
    // invite consumption so retries with a valid email still succeed.
    // D-INV-11: invalid/used/revoked invite AND duplicate email collapse to
    // the same 400 message so an attacker cannot probe registered emails
    // even when they hold a valid invite.
    const inputHash = hashInviteToken(inviteCode);
    const InvalidInvite = Symbol('InvalidInvite');

    try {
      const user = await getDb().transaction(async (tx) => {
        const consumed = await tx
          .update(inviteCodes)
          .set({ usedAt: new Date() })
          .where(and(
            eq(inviteCodes.hash, inputHash),
            isNull(inviteCodes.usedAt),
            isNull(inviteCodes.revokedAt),
          ))
          .returning({ id: inviteCodes.id });
        if (consumed.length === 0) {
          throw InvalidInvite;
        }

        const passwordHash = await hashPassword(password);
        let newUser;
        try {
          [newUser] = await tx
            .insert(users)
            .values({ email, displayName, passwordHash })
            .returning({ id: users.id, email: users.email, displayName: users.displayName });
        } catch (err: any) {
          if (err?.code === '23505') {
            // Duplicate email: collapse to InvalidInvite so the consumption
            // rolls back and the response never confirms email existence.
            throw InvalidInvite;
          }
          throw err;
        }

        await tx
          .update(inviteCodes)
          .set({ consumedByUserId: newUser.id })
          .where(eq(inviteCodes.id, consumed[0].id));

        return newUser;
      });

      const accessToken = await issueAccessToken(user.id);
      const refreshToken = await issueRefreshToken(user.id);
      setRefreshCookie(c, refreshToken);

      return c.json({ accessToken, user }, 200);
    } catch (err) {
      if (err === InvalidInvite) {
        return c.json({ error: 'Invalid or used invite code' }, 400);
      }
      throw err;
    }
  })

  .openapi(loginRoute, async (c) => {
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

  .openapi(refreshRoute, async (c) => {
    const cookie = getCookie(c, REFRESH_COOKIE_NAME);
    if (!cookie) return c.json({ error: 'No refresh token' }, 401);
    const rotated = await rotateRefreshToken(cookie);
    if (!rotated) {
      deleteCookie(c, REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
      return c.json({ error: 'Invalid refresh token' }, 401);
    }
    const accessToken = await issueAccessToken(rotated.userId);
    setRefreshCookie(c, rotated.newToken);
    return c.json({ accessToken }, 200);
  })

  .openapi(logoutRoute, async (c) => {
    const cookie = getCookie(c, REFRESH_COOKIE_NAME);
    if (cookie) {
      await revokeRefreshToken(cookie);
    }
    deleteCookie(c, REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    return c.body(null, 204);
  })

  // GET /auth/me -- returns the current user (protected by requireAuth)
  // Used by the web client's ProtectedRoute after cold-load silent refresh
  // so the user identity is rehydrated into the in-memory auth store.
  .openapi(meRoute, async (c) => {
    const userId = c.var.userId;
    const user = await getDb().query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true, displayName: true, llmConsentedAt: true },
    });
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json(
      {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        llmConsentedAt: user.llmConsentedAt ? user.llmConsentedAt.toISOString() : null,
      },
      200,
    );
  });
