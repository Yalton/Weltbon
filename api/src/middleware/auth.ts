import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { verifyAccessToken } from '../services/auth.js';
import { lookupPat, PAT_PREFIX } from '../services/pat.js';

export type AuthVariables = { userId: string };

function extractBearer(c: { req: { header: (name: string) => string | undefined } }): string {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing bearer token' });
  }
  return header.slice(7);
}

// requireAuth: JWT verify first (fast, in-memory), then PAT fallback (DB lookup) — per D-11
export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const token = extractBearer(c);
    // 1. JWT path (existing fast in-memory path)
    try {
      const userId = await verifyAccessToken(token);
      c.set('userId', userId);
      await next();
      return;
    } catch {
      // fall through to PAT lookup
    }
    // 2. PAT path (new) — only attempt if token has the wbn_pat_ prefix
    if (token.startsWith(PAT_PREFIX)) {
      const pat = await lookupPat(token);
      if (pat) {
        c.set('userId', pat.userId);
        // lookupPat fires-and-forgets last_used_at update internally (D-09)
        await next();
        return;
      }
    }
    throw new HTTPException(401, { message: 'Invalid token' });
  }
);

// requireJwtAuth: JWT-only — used by PAT meta-API routes per D-13
// A PAT bearer token is rejected here — prevents stolen PAT from minting more PATs.
export const requireJwtAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const token = extractBearer(c);
    let userId: string;
    try {
      userId = await verifyAccessToken(token);
    } catch {
      throw new HTTPException(401, { message: 'Invalid token' });
    }
    c.set('userId', userId);
    await next();
  }
);
