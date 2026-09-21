import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
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
import { ensureLocalUser } from '../services/local-mode.js';
import { env } from '../config.js';
import { isUniqueViolation } from '../db/pg-error.js';

type AppEnv = { Variables: AuthVariables };

// ─── Share-token rejection guard ─────────────────────────────────────────────
// T-29-22 (SHARE-03): The /api/share/* namespace is the SINGLE auditable
// surface that accepts the `share-token` credential. Public routes like
// /auth/register and /auth/login do NOT require bearer auth, so Hono's Zod
// body validator would otherwise fire BEFORE any auth check and return 400 on
// share-token header but no Authorization bearer is rejected with 401 —
// matching the boundary contract the SHARE-03 integration test enforces.
const rejectShareToken = createMiddleware(async (c, next) => {
  const hasShareToken = Boolean(c.req.header('share-token'));
  const hasBearer = c.req.header('Authorization')?.startsWith('Bearer ');
  if (hasShareToken && !hasBearer) {
    throw new HTTPException(401, { message: 'share-token is not accepted on this endpoint' });
  }
  await next();
});


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
  isAdmin: z.boolean(),
});

// BL-02 fix: /auth/me MUST NOT expose llmConsentedAt under requireAuth (which
// accepts PAT bearers). LLMKEY-06 / D-13 mirror requires that PATs cannot read
// the consent state — GET /api/llm-keys/consent is JWT-only and is the single
// source of truth. The web client calls /api/llm-keys/consent (via
const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
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


const registerRoute = createRoute({
  method: 'post',
  path: '/register',
  tags: ['Auth'],
  summary: 'Register a new user',
  description: 'Creates a new user account. Requires a valid invite code.',
  security: [],
  middleware: [rejectShareToken] as const,
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
  middleware: [rejectShareToken] as const,
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
  middleware: [rejectShareToken] as const,
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
  middleware: [rejectShareToken] as const,
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
      description: 'Current user profile. Consent state lives on GET /api/llm-keys/consent (JWT-only).',
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

const localSessionRoute = createRoute({
  method: 'post',
  path: '/local-session',
  tags: ['Auth'],
  summary: 'Mint a session for the sole local user (desktop app only)',
  description:
    'DV-11. This route is only REGISTERED at all when WELTBON_LOCAL_MODE is set — a server ' +
    'deployment never mounts it, so its own OpenAPI document and /api/docs never mention it. ' +
    'When mounted, the handler additionally requires the real TCP peer (read from the Node ' +
    'socket, not a client-supplied header) to be loopback, refuses outright if the request ' +
    'carries an X-Forwarded-For header at all, and refuses unless the Host header names a ' +
    'loopback hostname (the DNS-rebinding defence: a page on an attacker-controlled domain ' +
    'rebound to 127.0.0.1 is same-origin to the browser and passes every other check here). ' +
    'Every refusal path THIS route itself decides on returns the exact same 404 shape as an ' +
    'unmounted route — but a request carrying a share-token header without an Authorization ' +
    'bearer is rejected 401 by the router-wide rejectShareToken middleware before this ' +
    'handler ever runs, so that one path is not 404. Mints a session with no credential ' +
    'presented — its safety is the env flag, conditional route registration, and the ' +
    'socket/Host loopback checks, together.',
  security: [],
  middleware: [rejectShareToken] as const,
  responses: {
    200: { content: { 'application/json': { schema: refreshResponseSchema } }, description: 'Local session issued' },
    404: { description: 'Refused (non-loopback peer, or a forwarded request) — identical in shape to a route that does not exist' },
  },
});


// const, so that the local-session route's registration can depend on
// this on every invocation). A module-level const would freeze the decision
// createApp() calls, and conceptually wrong for the security property this
// route depends on: a server deployment must have NO local-session handler
export function buildAuthRoutes(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>()

  .openapi(registerRoute, async (c) => {
    const { email, password, displayName, inviteCode } = c.req.valid('json');

    // D-INV-11: invalid/used/revoked invite AND duplicate email collapse to
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
            .returning({ id: users.id, email: users.email, displayName: users.displayName, isAdmin: users.isAdmin });
        } catch (err: unknown) {
          // back and the response never confirms email existence (D-INV-11).
          if (isUniqueViolation(err)) {
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
    if (!(await verifyPassword(password, user.passwordHash)) || user.disabledAt !== null) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }
    const accessToken = await issueAccessToken(user.id);
    const refreshToken = await issueRefreshToken(user.id);
    setRefreshCookie(c, refreshToken);
    return c.json({
      accessToken,
      user: { id: user.id, email: user.email, displayName: user.displayName, isAdmin: user.isAdmin },
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
    const user = await getDb().query.users.findFirst({
      where: eq(users.id, rotated.userId),
      columns: { id: true, disabledAt: true },
    });
    if (!user || user.disabledAt !== null) {
      deleteCookie(c, REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
      return c.json({ error: 'Invalid refresh token' }, 401);
    }
    const accessToken = await issueAccessToken(rotated.userId);
    // newToken === null is the benign-replay path (a concurrent tab already
    if (rotated.newToken !== null) {
      setRefreshCookie(c, rotated.newToken);
    }
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
      columns: { id: true, email: true, displayName: true, isAdmin: true },
    });
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json(
      {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        isAdmin: user.isAdmin,
      },
      200,
    );
  });


  // is actually on. `env().localMode` is re-checked HERE, live, each time
  // path for /local-session: GET /api/openapi.json and /api/docs never

  // no-route-matched path — byte-identical to any other unmounted path

  if (env().localMode) {
    router.openapi(localSessionRoute, async (c) => {

      // router-construction time above.
      if (!env().localMode) return c.notFound();


      // or trust client-supplied header content, which any caller who can
      // reach this port can omit, forge, or list-prefix at will.
      if (c.req.header('x-forwarded-for') !== undefined) return c.notFound();

      // DNS-rebinding defence. A page at evil.example rebound to 127.0.0.1 makes
      // requests the browser treats as SAME-ORIGIN, so CORS is never consulted and
      const hostHeader = c.req.header('host') ?? '';
      const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
      const hostIsLoopback =
        hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
      if (!hostIsLoopback) return c.notFound();

      // The real TCP peer, read off the Node socket via @hono/node-server —
      // a route that mints a session with no credential, "we could not tell"
      const remote = getConnInfo(c).remote.address;
      const isLoopback =
        remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLoopback) return c.notFound();


      const user = await ensureLocalUser(getDb());
      const accessToken = await issueAccessToken(user.id);
      const refreshToken = await issueRefreshToken(user.id);
      setRefreshCookie(c, refreshToken);
      return c.json({ accessToken }, 200);
    });
  }

  return router;
}
