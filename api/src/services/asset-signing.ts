/**
 * Phase 38 UAT-fix — HMAC-signed asset URLs.
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
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { assets } from '../db/schema.js';

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

/**
 * Generate a signed query suffix for an authed asset URL.
 *
 * @param uid       Universe UUID
 * @param id        Asset UUID
 * @param variant   'raw' | 'thumb'
 * @param ttlSec    Validity window in seconds (default 86400 = 24 h)
 * @returns         Query string suffix including leading '?', e.g. `?e=1234567890&s=abc…`
 */
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

/**
 * Verify an asset URL signature (for authed routes where uid comes from the URL path).
 *
 * @param uid     Universe UUID (from path)
 * @param id      Asset UUID (from path)
 * @param variant 'raw' | 'thumb' (from path segment)
 * @param e       Expiry epoch seconds (from query param, as string)
 * @param s       Hex HMAC signature (from query param)
 * @returns       true iff the signature is valid and not expired; false on any error
 */
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
    // Reject expired signatures.
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

/**
 * Generate a signed query suffix for a share-mode asset URL.
 *
 * Share asset routes have no :uid path param (D-03 — visitor never sees the
 * internal universe UUID), so the universe ID is embedded in the query as `?u=`.
 * The HMAC message is the same `${uid}:${id}:${variant}:${exp}` — the `u` param
 * is verified server-side by extracting it from the query and recomputing the sig.
 *
 * @param uid       Universe UUID (embedded in query, not path)
 * @param id        Asset UUID
 * @param variant   'raw' | 'thumb'
 * @param ttlSec    Validity window in seconds (default 86400 = 24 h)
 * @returns         Query string suffix, e.g. `?u=<uid>&e=<exp>&s=<sig>`
 */
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

/**
 * Verify a share-mode asset URL signature.
 *
 * The `u` (universe id) query param is trusted ONLY insofar as it was signed —
 * the HMAC binds uid + id + variant + exp, so a forged/substituted `u` value
 * will produce a signature mismatch. The caller must STILL enforce the
 * `is_public` gate via `getPublicAsset(uid, id)` after this call passes.
 *
 * @param id      Asset UUID (from path)
 * @param variant 'raw' | 'thumb' (from path segment)
 * @param u       Universe UUID (from query param)
 * @param e       Expiry epoch seconds (from query param)
 * @param s       Hex HMAC signature (from query param)
 * @returns       `{ valid: true, uid }` or `{ valid: false }`
 */
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

/**
 * Batched asset-ownership lookup — the one piece every signed-URL resolver shares.
 *
 * Returns the subset of `ids` that exist AND belong to `universeId`. Callers use it to
 * decide whether to mint a signed URL: an id that is missing (dangling FK) or owned by
 * another universe must resolve to null, never to a URL. Deliberately NOT a URL builder —
 * the authed and share paths differ in URL shape and signer, and unifying those would need
 * a config object nobody wants to read.
 *
 * One query for the whole page; an empty `ids` issues no query at all.
 */
export async function assetOwners(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reader: any,
  ids: string[],
  universeId: string,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await reader
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.universeId, universeId), inArray(assets.id, ids)));
  return new Set(rows.map((r: { id: string }) => r.id));
}
