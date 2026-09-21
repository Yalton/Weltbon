/**
 *
 * Allows browsers to fetch asset raw/thumb bytes via <img src> without needing
 * an Authorization: Bearer header (which browser image tags cannot attach).
 *
 * Design:
 *   - Secret: MEDIA_URL_SIGNING_SECRET env var, falling back to the raw JWT_SECRET
 *     string (same environment variable; self-hosters need no new required env).
 *   - signAssetUrl(uid, id, variant, ttlSec): returns query suffix `?e=<expEpoch>&s=<hex>`
 *     where the HMAC message is exactly `${uid}:${id}:${variant}:${exp}`.
 *   - verifyAssetSig(uid, id, variant, e, s): recomputes HMAC, uses timing-safe
 *     comparison, and checks exp > nowSeconds. Returns false on any error.
 *
 * Security properties:
 *   - Timing-safe: `crypto.timingSafeEqual` prevents timing oracle on the sig check.
 *   - Expiry-enforced: signatures are refused after TTL (default 24 h).
 *   - Scoped: HMAC message binds uid + id + variant — a thumb sig is rejected on the
 *     raw endpoint and vice-versa; a sig for one universe/id pair is rejected for any other.
 *
 * Also owns the ownership predicate the URL minters gate on (assetOwners); that DB read
 * takes a `reader` param so this module never imports db/client — the pure-signing unit
 * lane stays pool-free.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';
import { assets } from '../db/schema.js';

type Schema = typeof schema;

/** Return the raw signing secret string (not the Uint8Array used by JWT). */
function signingSecret(): string {
  const s = process.env.MEDIA_URL_SIGNING_SECRET ?? process.env.JWT_SECRET;
  if (!s) {
    throw new Error('JWT_SECRET (or MEDIA_URL_SIGNING_SECRET) must be set for asset URL signing');
  }
  return s;
}

function computeHmac(uid: string, id: string, variant: 'raw' | 'thumb', exp: number): string {
  const msg = `${uid}:${id}:${variant}:${exp}`;
  return createHmac('sha256', signingSecret()).update(msg).digest('hex');
}

export function signAssetUrl(
  uid: string,
  id: string,
  variant: 'raw' | 'thumb',
  ttlSec = 86400,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = computeHmac(uid, id, variant, exp);
  return `?e=${exp}&s=${sig}`;
}

export function verifyAssetSig(
  uid: string,
  id: string,
  variant: 'raw' | 'thumb',
  e: string | undefined,
  s: string | undefined,
): boolean {
  try {
    if (!e || !s) return false;
    const exp = Number(e);
    if (!Number.isFinite(exp)) return false;
    if (exp <= Math.floor(Date.now() / 1000)) return false;
    const expected = computeHmac(uid, id, variant, exp);
    // Timing-safe comparison (prevents timing oracle attacks on the hex string).
    const a = Buffer.from(s.padEnd(expected.length, '\0'), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signShareAssetUrl(
  uid: string,
  id: string,
  variant: 'raw' | 'thumb',
  ttlSec = 86400,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = computeHmac(uid, id, variant, exp);
  return `?u=${uid}&e=${exp}&s=${sig}`;
}

export function verifyShareAssetSig(
  id: string,
  variant: 'raw' | 'thumb',
  u: string | undefined,
  e: string | undefined,
  s: string | undefined,
): { valid: boolean; uid: string } {
  try {
    if (!u || !e || !s) return { valid: false, uid: '' };
    const exp = Number(e);
    if (!Number.isFinite(exp)) return { valid: false, uid: '' };
    if (exp <= Math.floor(Date.now() / 1000)) return { valid: false, uid: '' };
    const expected = computeHmac(u, id, variant, exp);
    const a = Buffer.from(s.padEnd(expected.length, '\0'), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return { valid: false, uid: '' };
    const ok = timingSafeEqual(a, b);
    return ok ? { valid: true, uid: u } : { valid: false, uid: '' };
  } catch {
    return { valid: false, uid: '' };
  }
}

export async function assetOwners(
  reader: NodePgDatabase<Schema>,
  ids: string[],
  universeId: string,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await reader
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.universeId, universeId), inArray(assets.id, ids)));
  return new Set(rows.map((r) => r.id));
}
