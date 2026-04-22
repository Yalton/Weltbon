import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import * as jose from 'jose';
import { env } from '../config.js';

export type AuthVariables = { userId: string };

/**
 * Hono middleware that verifies the Bearer JWT in the Authorization header.
 * Sets c.var.userId on success; throws 401 on missing/invalid token.
 */
export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }
    const token = header.slice(7);
    try {
      const { payload } = await jose.jwtVerify(token, env().jwtSecret, {
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string') {
        throw new Error('Missing sub claim');
      }
      c.set('userId', payload.sub);
    } catch {
      throw new HTTPException(401, { message: 'Invalid or expired token' });
    }
    await next();
  },
);
