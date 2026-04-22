import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { verifyAccessToken } from '../services/auth.js';

export type AuthVariables = { userId: string };

export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new HTTPException(401, { message: 'Missing bearer token' });
    }
    const token = header.slice(7);
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
