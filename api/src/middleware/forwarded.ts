import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';

export type ForwardedVariables = { publicOrigin: string };

/**
 * Builds an absolute public URL for the current request, honoring proxy headers.
 *
 * Precedence:
 *   1. X-Forwarded-Proto / X-Forwarded-Host (set by a trusted reverse proxy)
 *   2. The request's own Host header + 'http' scheme (in-container fallback)
 *
 * The operator is responsible for ensuring the proxy strips client-supplied
 * X-Forwarded-* headers before forwarding — see docs/reverse-proxy/.
 *
 * @param c    Hono Context for the current request
 * @param path Optional path to append (e.g. '/api/foo'); must start with '/'
 * @returns    e.g. 'https://welt.example.com' or 'https://welt.example.com/api/foo'
 */
export function buildPublicUrl(c: Context, path?: string): string {
  const proto = c.req.header('X-Forwarded-Proto') ?? 'http';
  const host = c.req.header('X-Forwarded-Host') ?? c.req.header('Host') ?? 'localhost';
  const origin = `${proto}://${host}`;
  return path ? `${origin}${path}` : origin;
}

/**
 * Resolves the public origin once per request and stashes it on c.var.publicOrigin.
 * Always succeeds — falls back to in-container values when X-Forwarded-* are absent.
 */
export const forwarded = createMiddleware<{ Variables: ForwardedVariables }>(
  async (c, next) => {
    c.set('publicOrigin', buildPublicUrl(c));
    await next();
  }
);
