import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config.js';
import { isUniqueViolation } from '../db/pg-error.js';
import { requireAdmin, type AuthVariables } from '../middleware/auth.js';
import { clientIp } from '../middleware/forwarded.js';
import { createFixedWindowLimiter } from '../services/rate-limit.js';
import {
  dismissInviteRequest,
  InviteRequestNotPendingError,
  issueInviteRequest,
  listInviteRequests,
  submitInviteRequest,
} from '../services/invite-requests.js';

type AppEnv = { Variables: AuthVariables };

// 5 submissions per client IP per hour. In-memory: see services/rate-limit.ts.
const submitLimiter = createFixedWindowLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });

export function _resetInviteRequestRateLimitForTests(): void {
  submitLimiter.reset();
}

const submitSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().max(254).email(),
  note: z.string().trim().max(1000).nullish().transform((v) => v || null),
});

const statusSchema = z.enum(['pending', 'issued', 'dismissed']);
const ACCEPTED = { ok: true } as const;
const notPending = { error: 'Invite request has already been reviewed', code: 'not_pending' } as const;

function requestId(raw: string): string {
  const parsed = z.string().uuid().safeParse(raw);
  if (!parsed.success) throw new HTTPException(404, { message: 'Invite request not found' });
  return parsed.data;
}

/**
 * Public, unauthenticated: the landing page's "request an invite" form. Every
 * accepted-looking outcome (stored, duplicate, honeypot) answers the same 202 so
 * the endpoint reveals nothing about which emails have already asked.
 */
export const inviteRequestRoutes = new OpenAPIHono<AppEnv>()
  .post('/', async (c) => {
    const { inviteRequestsEnabled, localMode } = env();
    // Same 404 as an unmounted route: local mode has no accounts to invite into.
    if (!inviteRequestsEnabled || localMode) return c.notFound();

    const limit = submitLimiter.hit(clientIp(c));
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfterSeconds));
      return c.json({ error: 'Too many requests, try again later', code: 'rate_limited' }, 429);
    }

    const body: unknown = await c.req.json().catch(() => null);
    // Honeypot: a hidden field people never see but form-filling bots do.
    const website = (body as { website?: unknown } | null)?.website;
    if (typeof website === 'string' && website.trim() !== '') return c.json(ACCEPTED, 202);

    const parsed = submitSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid request', code: 'invalid_request' }, 400);
    await submitInviteRequest(parsed.data);
    return c.json(ACCEPTED, 202);
  });

export const adminInviteRequestRoutes = new OpenAPIHono<AppEnv>()
  .get('/', requireAdmin, async (c) => {
    const raw = c.req.query('status');
    if (raw === undefined) return c.json(await listInviteRequests(), 200);
    const status = statusSchema.safeParse(raw);
    if (!status.success) return c.json({ error: 'Invalid status', code: 'invalid_status' }, 400);
    return c.json(await listInviteRequests(status.data), 200);
  })
  .post('/:id/issue', requireAdmin, async (c) => {
    const id = requestId(c.req.param('id'));
    try {
      const result = await issueInviteRequest(c.var.userId, id);
      if (!result) throw new HTTPException(404, { message: 'Invite request not found' });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof InviteRequestNotPendingError) return c.json(notPending, 409);
      if (isUniqueViolation(error)) return c.json({ error: 'Invite code collision, please retry' }, 409);
      throw error;
    }
  })
  .post('/:id/dismiss', requireAdmin, async (c) => {
    const id = requestId(c.req.param('id'));
    try {
      const result = await dismissInviteRequest(c.var.userId, id);
      if (!result) throw new HTTPException(404, { message: 'Invite request not found' });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof InviteRequestNotPendingError) return c.json(notPending, 409);
      throw error;
    }
  });
