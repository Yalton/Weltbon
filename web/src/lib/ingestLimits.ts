// Mirrors api/src/routes/ingest.ts D-15 caps. Update both sites if either changes.
//
// Source of truth: api/src/routes/ingest.ts:43-46
//   MAX_FILES                = 1000
//   MAX_FILE_SIZE            = 1 MB    (per-.md file)
//   MAX_ZIP_SIZE             = 50 MB   (compressed archive)
//   MAX_TOTAL_UNCOMPRESSED   = 100 MB  (sum of all .md content extracted)
//
// These constants drive the DropZone helper text (Plan 12-05) and any
// client-side preflight checks that want to fail fast before posting.

export const BATCH_LIMIT_FILES = 1000;
export const BATCH_LIMIT_MB = 50;
export const BATCH_LIMIT_FILE_SIZE_MB = 1;
export const BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB = 100;
