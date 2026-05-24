/**
 * Phase 24-02 — gap_key canonicalization + v1: hash.
 *
 * Pure utility module — no DB import, no logger.
 *
 * Exports:
 *   - strictLexNormalize: deterministic title canonicalization (D-09)
 *   - computeGapKey: v1:<hex16> hash (D-08 + D-12)
 *
 * Algorithm (D-09):
 *   lowercase → NFC → trim → strip non-[a-z0-9 ] → collapse spaces
 *   Order matters: lowercase first (case-insensitive strip), NFC before
 *   stripping (combined chars normalized), trim before space-collapse
 *   (leading/trailing don't survive as singletons).
 *
 * Hash (D-08 + D-12):
 *   SHA-256(JSON.stringify([universeId, category, sortedRefs, normalizedTitle]))
 *   Truncated to 16 hex chars. universeId is the FIRST component per D-08
 *   to guarantee cross-universe non-collision at construction time.
 *
 * Analog: api/src/services/invite.ts (hashInviteToken pattern).
 */

import { createHash } from 'node:crypto';
import type { AuditCategory } from '../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GAP_KEY_VERSION = 'v1' as const;

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * D-09: Strict lexical normalization for gap_key title component.
 *
 * Steps (order is load-bearing):
 *   1. toLowerCase()        — case-insensitive dedup
 *   2. normalize('NFC')     — combined Unicode chars normalized (explicit D-09)
 *   3. trim()               — remove leading/trailing whitespace
 *   4. replace non-[a-z0-9 ] — strip punctuation, accented chars, symbols
 *   5. collapse \s+          — normalize internal whitespace runs
 */
export function strictLexNormalize(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFC')
    .trim()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * D-08 + D-12: Compute a stable, version-prefixed gap key.
 *
 * Hash input: JSON.stringify([universeId, category, sortedRefs, normalizedTitle])
 *   - universeId is the FIRST array element per D-08 (cross-universe collision impossible)
 *   - refs are lexicographically sorted for order-independence
 *   - title is run through strictLexNormalize before hashing (D-09 + D-10)
 *   - SHA-256 hex truncated to 16 chars (collision math: ~5×10^18 space >> expected
 *     universe scale of ~10^4 entries; researcher confirmation per CONTEXT)
 *
 * Returns a string of shape `v1:<16-hex-chars>`.
 */
export function computeGapKey(
  universeId: string,
  category: AuditCategory,
  referencedEntryIds: string[],
  title: string,
): string {
  const sortedRefs = [...referencedEntryIds].sort();
  const canonical = JSON.stringify([universeId, category, sortedRefs, strictLexNormalize(title)]);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${GAP_KEY_VERSION}:${hash}`;
}
