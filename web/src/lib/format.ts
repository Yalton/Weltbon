import { ApiError } from '../api/client';
import {
  BATCH_LIMIT_FILES,
  BATCH_LIMIT_MB,
  BATCH_LIMIT_FILE_SIZE_MB,
  BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB,
} from './ingestLimits';

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
 * Branch order (LOCKED — TD-03 split as of Phase 16):
 *   1. Legacy `version` text-match → incompatible-version copy.
 *   2. NEW (TD-03) `title still collides` text-match → title-collision copy.
 *      Triggered by the API's `TitleCollisionError` (api/src/services/ingest-commit.ts)
 *      which surfaces as ApiError(409, { error: 'Title still collides: <title>' }).
 *   3. NEW (TD-03) `invalid category id` text-match → category-unresolved copy.
 *      MUST precede the legacy invalid|format|parse branch because the string
 *      'invalid category id' contains the substring 'invalid' which would
 *      otherwise be swallowed by branch 4.
 *      Triggered by ApiError(400, { error: 'Invalid category id' }).
 *   4. Legacy `invalid` | `format` | `parse` text-match → not-a-valid-export copy.
 *      Legacy branches WIN over status-code dispatch — a 500 with
 *      `error: "invalid markdown"` returns the legacy copy, not DB-rejection.
 *   5. Status-code dispatch (UI-SPEC §6.6 commit-error table):
 *      - 403          → permission-denied
 *      - 409          → title-collision (TD-03 fallback; old copy retired in Phase 16)
 *      - 413 (upload) → upload-too-large (typed `limit` field)
 *      - 413 (other)  → commit-too-large
 *      - >=500        → DB-rejected
 *   6. Fallback: server's raw `error` field (for unmatched 4xx).
 *   7. Non-ApiError SyntaxError → not-a-valid-export.
 *   8. Network / unknown → server-unreachable.
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

    // TD-03: title-collision text-match — MUST precede status-code dispatch.
    if (msg.toLowerCase().includes('title still collides'))
      return 'One or more entry titles are already in use in this universe. Rename the conflicting entries in your review and re-commit.';

    // TD-03: category-unresolved text-match — MUST precede the legacy
    // invalid|format|parse branch because 'invalid category id' contains 'invalid'.
    if (msg.toLowerCase().includes('invalid category id'))
      return 'A category you selected was removed or renamed since you opened the review. Refresh the review and re-pick categories.';

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
      // TD-03: 409 fallback copy is the title-collision message. The literal
      // 'title still collides' string is caught upstream; this branch covers any
      // future 409 that doesn't include that exact string.
      return 'One or more entry titles are already in use in this universe. Rename the conflicting entries in your review and re-commit.';
    if (err.status === 413) {
      // Phase 12-05 parse-time discriminator: the Phase 11 ingest endpoint
      // returns `{ error, limit: 'file_count' | 'file_size' | 'zip_size' |
      // 'total_uncompressed_size' }` on a 413. Match exactly on the typed
      // `limit` field (NOT the human-readable error text) and return the
      // §10/§6.6 copy with the limit interpolated from ingestLimits.ts.
      const limit =
        body && typeof body === 'object' && 'limit' in body
          ? String(body.limit)
          : null;
      if (limit === 'file_count')
        return `Too many files (max ${BATCH_LIMIT_FILES}). Try splitting your upload.`;
      if (limit === 'file_size')
        return `One file is too large (max ${BATCH_LIMIT_FILE_SIZE_MB} MB per file).`;
      if (limit === 'zip_size')
        return `That ZIP is too large (max ${BATCH_LIMIT_MB} MB compressed). Try splitting it.`;
      if (limit === 'total_uncompressed_size')
        return `That ZIP would expand beyond ${BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB} MB after unzipping.`;

      // Legacy commit-time keyword fallback (preserved for callers without a
      // structured `limit` field — e.g., the commit endpoint per Plan 12-02).
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
