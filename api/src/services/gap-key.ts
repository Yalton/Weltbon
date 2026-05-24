/**
 * Phase 24 AUDIT-08: Deterministic gap_key computation.
 *
 * The gap_key is a stable dedup handle for AI-sourced Issues. Two suggestions
 * that describe the same gap (same universe, category, referenced entries, and
 * canonically-equivalent title) produce the same gap_key — enabling
 * idempotent re-runs via the (universe_id, gap_key) UNIQUE NULLS NOT DISTINCT
 * constraint on the `issues` table (AUDIT-02).
 *
 * Design decisions (CONTEXT):
 *   D-08: gap_key computation lives server-side; never LLM-emitted.
 *   D-09: Strict lexical normalization (lowercase, NFC, trim, collapse
 *         whitespace, strip non-alphanumeric except space). No stemming, no
 *         stopword removal. English-language-neutral.
 *   D-10: Title-only source. Bodies drift across re-runs even for the same gap;
 *         titles tend to converge, giving predictable dismissal stickiness.
 *   D-12: Version-prefixed format: 'v1:<sha256-hex-16>'. If canonicalization
 *         rules change, bump to 'v2:' — old v1: dismissals stay valid for
 *         existing Issues and don't silently no-op against new v2: findings.
 *
 * Algorithm:
 *   1. Normalize the title per D-09.
 *   2. Sort referencedEntryIds for canonical ordering.
 *   3. JSON.stringify([universeId, category, sortedIds, normalizedTitle]).
 *   4. SHA-256, take first 16 hex chars.
 *   5. Prefix with 'v1:'.
 *
 * Cross-universe collision prevention: universeId is the first component of
 * the hashed tuple, so even identical (category, entries, title) tuples from
 * different universes produce different gap_keys.
 */

import { createHash } from 'node:crypto';
import type { AuditCategory } from '../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAP_KEY_VERSION = 'v1';

// ---------------------------------------------------------------------------
// Canonicalization (D-09)
// ---------------------------------------------------------------------------

/**
 * Strict lexical normalization (CONTEXT D-09):
 *   - NFC Unicode normalization
 *   - Lowercase
 *   - Trim leading/trailing whitespace
 *   - Strip non-alphanumeric characters except space
 *   - Collapse internal whitespace to single space
 *
 * Examples:
 *   '  Hello, World!  ' → 'hello world'
 *   'Alice & Bob'       → 'alice  bob' → 'alice bob'
 *   'Café'              → 'caf'          (accented chars stripped after NFC)
 */
export function strictLexNormalize(title: string): string {
  return title
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Gap-key computation (D-08 + D-12)
// ---------------------------------------------------------------------------

/**
 * Compute a stable, version-prefixed gap_key for a suggestion.
 *
 * @param universeId       UUID of the universe (first hash component — prevents cross-universe collisions).
 * @param category         One of the five AuditCategory values.
 * @param referencedEntryIds  Entry UUIDs referenced by the suggestion (order-normalized via sort).
 * @param title            Suggestion title (canonicalized per D-09 before hashing).
 * @returns                String of shape 'v1:<16-hex-char>'.
 */
export function computeGapKey(
  universeId: string,
  category: AuditCategory,
  referencedEntryIds: string[],
  title: string,
): string {
  const sorted = [...referencedEntryIds].sort();
  const canonical = JSON.stringify([universeId, category, sorted, strictLexNormalize(title)]);
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${GAP_KEY_VERSION}:${hash}`;
}
