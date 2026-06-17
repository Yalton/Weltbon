import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { verifyAccessToken } from '../services/auth.js';
import { lookupPat, PAT_PREFIX } from '../services/pat.js';
import { verifyAssetSig } from '../services/asset-signing.js';

export type AuthVariables = { userId: string };

function extractBearer(c: { req: { header: (name: string) => string | undefined } }): string {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing bearer token' });
  }
  return header.slice(7);
}

/**
 * Phase 38 UAT-fix: signed-asset bypass guard.
 *
 * Returns true ONLY when ALL conditions hold:
 *   - Method is GET
 *   - Path matches /api/universes/<uuid>/assets/<uuid>/(raw|thumb)
 *   - The ?e and ?s query params form a valid, unexpired HMAC-SHA256 signature
 *
 * This allows browser <img> tags to load asset bytes without an Authorization
 * header (which browsers cannot attach to image src fetches). The bypass is
 * strictly scoped — no other route path, no other method, no expired/invalid
 * signature can pass. userId is intentionally NOT set so handlers on the
 * bearer path can still distinguish auth mode.
 */
const ASSET_SERVE_PATH_RE =
  /^\/api\/universes\/([0-9a-f-]{36})\/assets\/([0-9a-f-]{36})\/(raw|thumb)$/i;

function isSignedAssetBypass(
  method: string,
  path: string,
  query: (key: string) => string | undefined,
): boolean {
  if (method !== 'GET') return false;
  const m = ASSET_SERVE_PATH_RE.exec(path);
  if (!m) return false;
  const [, uid, id, variant] = m;
  return verifyAssetSig(uid, id, variant as 'raw' | 'thumb', query('e'), query('s'));
}

// requireAuth: JWT verify first (fast, in-memory), then PAT fallback (DB lookup) — per D-11
export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    // Phase 38 UAT-fix: allow signed GET asset requests through without a bearer token.
    // The signature IS the capability — the route handler re-verifies and scopes the row.
    // This bypass is intentionally narrow: only GET + matching path + valid sig passes.
    if (isSignedAssetBypass(c.req.method, c.req.path, (k) => c.req.query(k))) {
      await next();
      return;
    }

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
