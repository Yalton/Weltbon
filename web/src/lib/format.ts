import { ApiError } from '../api/client';
import {
  BATCH_LIMIT_FILES,
  BATCH_LIMIT_MB,
  BATCH_LIMIT_FILE_SIZE_MB,
  BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB,
} from './ingestLimits';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
    if (msg.toLowerCase().includes('invalid category id'))
      return 'A category you selected was removed or renamed since you opened the review. Refresh the review and re-pick categories.';

    if (
      msg.toLowerCase().includes('invalid') ||
      msg.toLowerCase().includes('format') ||
      msg.toLowerCase().includes('parse')
    )
      return 'This file is not a valid Weltbon export. Check the file and try again.';

    if (err.status === 403)
      return "You don't have permission to import to this universe.";
    if (err.status === 409)
      // TD-03: 409 fallback copy is the title-collision message. The literal
      return 'One or more entry titles are already in use in this universe. Rename the conflicting entries in your review and re-commit.';
    if (err.status === 413) {
      // `limit` field (NOT the human-readable error text) and return the
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
  return "Couldn't reach the server. Your review is saved locally. Try again.";
}

export function pluralize(n: number, singular: string, plural: string = singular + 's'): string {
  return n === 1 ? `${n} ${singular}` : `${n} ${plural}`;
}
