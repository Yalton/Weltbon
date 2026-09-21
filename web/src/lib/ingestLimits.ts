// Mirrors api/src/routes/ingest.ts D-15 caps. Update both sites if either changes.
// Source of truth: api/src/routes/ingest.ts:43-46
//   MAX_FILE_SIZE            = 1 MB    (per-.md file)
// client-side preflight checks that want to fail fast before posting.

export const BATCH_LIMIT_FILES = 1000;
export const BATCH_LIMIT_MB = 50;
export const BATCH_LIMIT_FILE_SIZE_MB = 1;
export const BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB = 100;

// #35 DOCX-06. Source of truth: api/src/services/ingest-docx/limits.ts
export const BATCH_LIMIT_DOCX_MB = 25;
export const BATCH_LIMIT_DOCX_FILES = 50;
