
import { createHash } from 'node:crypto';
import type { AuditCategory } from '../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export const GAP_KEY_VERSION = 'v1' as const;

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export function strictLexNormalize(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFC')
    .trim()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ');
}

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
