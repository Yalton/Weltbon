import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { lookupShareToken, SHARE_TOKEN_PREFIX } from '../services/share-token.js';

export type ShareVariables = { shareUniverseId: string; shareTokenId: string };

/**
 *
 * Security boundary (T-29-04): reads ONLY the `share-token` header. NEVER
 * inspects the bearer / Authz header — fall-through to JWT/PAT would let a
 * leaked authenticated bearer token unlock the share surface. The auth
 * middleware (api/src/middleware/auth.ts) symmetrically does NOT inspect
 * `share-token`.
 *
 * Failure modes ALL return `HTTPException(404)` with the same message
 * (D-05/D-06 + T-29-05): a visitor MUST NOT be able to distinguish
 *   - missing header
 *   - wrong prefix
 *   - unknown hash
 *   - revoked token
 *   - expired token
 * — all of those are indistinguishable from "share link does not exist".
 *
 * On success, sets `c.var.shareUniverseId` and `c.var.shareTokenId`. Access
 * tracking (`last_accessed_at` + `access_count++`) is fired fire-and-forget
 * inside `lookupShareToken` (D-09 / T-29-06) so this middleware does not
 * need to call `recordShareAccess` separately.
 */
export const requireShareToken = createMiddleware<{ Variables: ShareVariables }>(
  async (c, next) => {
    const token = c.req.header('share-token');
    if (!token) {
      throw new HTTPException(404, { message: 'Share link not found or expired' });
    }
    if (!token.startsWith(SHARE_TOKEN_PREFIX)) {
      // Prefix mismatch → 404 (not 401) to avoid leaking format info per T-29-05
      throw new HTTPException(404, { message: 'Share link not found or expired' });
    }
    const lookup = await lookupShareToken(token);
    if (lookup === null) {
      throw new HTTPException(404, { message: 'Share link not found or expired' });
    }
    c.set('shareUniverseId', lookup.universeId);
    c.set('shareTokenId', lookup.id);
    await next();
  },
);
