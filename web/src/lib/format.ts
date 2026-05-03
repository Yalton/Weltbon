import { ApiError } from '../api/client';

/**
 * Format a byte count as a human-readable string.
 * Lifted verbatim from web/src/components/ImportDialog.tsx (Phase 8 / pre-12).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Classify a thrown error into a user-facing message.
 *
 * Branch order (locked):
 *   1. Legacy text-match branches (preserved for JSON-import compatibility):
 *      - "version"                     → incompatible-version copy
 *      - "invalid" | "format" | "parse" → not-a-valid-export copy
 *      Legacy branches WIN over status-code dispatch — a 500 with
 *      `error: "invalid markdown"` returns the legacy copy, not the DB-rejection
 *      copy, so Phase 11 parse failures keep their existing message.
 *   2. Phase 12 status-code dispatch (UI-SPEC §6.6 commit-error table):
 *      - 403          → permission-denied
 *      - 409          → category-resolve
 *      - 413 (upload) → upload-too-large
 *      - 413 (other)  → commit-too-large
 *      - >=500        → DB-rejected
 *   3. Fallback: server's raw `error` field (for unmatched 4xx).
 *   4. Non-ApiError SyntaxError → not-a-valid-export.
 *   5. Network / unknown → server-unreachable.
 */
export function classifyError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as Record<string, unknown> | null;
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : err.message;

    // Legacy JSON-import branches (preserved; must precede status checks).
    if (msg.toLowerCase().includes('version'))
      return 'This file was created with an incompatible version of Weltbon. Export from a matching version and try again.';
    if (
      msg.toLowerCase().includes('invalid') ||
      msg.toLowerCase().includes('format') ||
      msg.toLowerCase().includes('parse')
    )
      return 'This file is not a valid Weltbon export. Check the file and try again.';

    // Phase 12 status-code branches (UI-SPEC §6.6).
    if (err.status === 403)
      return "You don't have permission to import to this universe.";
    if (err.status === 409)
      return 'Could not resolve a category name. Pick existing categories for any new ones.';
    if (err.status === 413) {
      if (
        msg.includes('zip_size') ||
        msg.includes('file_size') ||
        msg.includes('file_count') ||
        msg.includes('total_uncompressed_size')
      ) {
        return 'That batch exceeds the limit. Split it into smaller folders or remove some files and try again.';
      }
      return 'The reviewed batch is too large to commit in one transaction. Split it across multiple imports.';
    }
    if (err.status >= 500)
      return 'The database rejected the import — no changes were saved. Try again, or remove a problematic entry and retry.';

    return msg;
  }
  if (err instanceof SyntaxError)
    return 'This file is not a valid Weltbon export. Check the file and try again.';
  // Network / unknown.
  return "Couldn't reach the server. Your review is saved locally. Try again.";
}

/**
 * Plural-aware count formatter.
 * Per UI-SPEC §10 footer rule: `1 entry` for n === 1; `{n} entries` for any
 * other value (including 0).
 */
export function pluralize(n: number, singular: string, plural: string = singular + 's'): string {
  return n === 1 ? `${n} ${singular}` : `${n} ${plural}`;
}
