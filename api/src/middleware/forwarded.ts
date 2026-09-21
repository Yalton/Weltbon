import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';

export type ForwardedVariables = { publicOrigin: string };

export function buildPublicUrl(c: Context, path?: string): string {
  const proto = c.req.header('X-Forwarded-Proto') ?? 'http';
  const host = c.req.header('X-Forwarded-Host') ?? c.req.header('Host') ?? 'localhost';
  const origin = `${proto}://${host}`;
  return path ? `${origin}${path}` : origin;
}

export const forwarded = createMiddleware<{ Variables: ForwardedVariables }>(
  async (c, next) => {
    c.set('publicOrigin', buildPublicUrl(c));
    await next();
  }
);
