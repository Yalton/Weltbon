/**
 * Phase 38 MEDIA-01 (D-01): Pluggable StorageBackend interface.
 *
 * Abstracts byte-level file storage behind a stable contract so S3-compatible
 * (or any other) backends can be added later without touching call sites.
 * The current implementation is LocalStorageBackend (local.ts), bound to the
 * `uploads` Docker volume at /uploads.
 *
 * Keys are UUIDs (validated at the call site). The `safeJoin` guard in
 * LocalStorageBackend provides defense-in-depth path-traversal protection
 * (T-38-01: strip every char not matching [a-zA-Z0-9_\-]).
 */
export interface StorageBackend {
  /** Store bytes at a stable key; key = UUID (caller-generated). */
  put(key: string, data: Buffer): Promise<void>;
  /** Retrieve bytes by key. Returns null if not found. */
  get(key: string): Promise<Buffer | null>;
  /** Delete bytes by key. No-op if not found. */
  delete(key: string): Promise<void>;
  /** True if key exists. */
  exists(key: string): Promise<boolean>;
}
