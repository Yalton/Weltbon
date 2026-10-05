import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { env } from '../config.js';

export type ForwardedVariables = { publicOrigin: string };

export function buildPublicUrl(c: Context, path?: string): string {
  const proto = c.req.header('X-Forwarded-Proto') ?? 'http';
  const host = c.req.header('X-Forwarded-Host') ?? c.req.header('Host') ?? 'localhost';
  const origin = `${proto}://${host}`;
  return path ? `${origin}${path}` : origin;
}

/**
 * Best-effort client address, used as a rate-limit key (never for auth).
 *
 * X-Forwarded-For is only believed when the operator says a reverse proxy sits
 * in front (WELTBON_TRUST_PROXY=true). The documented nginx and Caddy configs
 * overwrite the header, so its right-most entry is the real peer. Exposed
 * directly, the header is whatever the client sent, so the TCP peer is used.
 */
export function clientIp(c: Context, opts: { trustProxy: boolean } = { trustProxy: env().trustProxy }): string {
  const forwardedFor = opts.trustProxy ? c.req.header('X-Forwarded-For') : undefined;
  if (forwardedFor) {
    const hops = forwardedFor.split(',').map((h) => h.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return address;
  } catch {
    // No Node socket bound (e.g. app.request() in tests).
  }
  return 'unknown';
}

export const forwarded = createMiddleware<{ Variables: ForwardedVariables }>(
  async (c, next) => {
    c.set('publicOrigin', buildPublicUrl(c));
    await next();
  }
);
