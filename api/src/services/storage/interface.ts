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
  /**
   * Store bytes at a stable key; key = UUID (caller-generated).
   *
   * MUST be atomic (F0-03): a failed put leaves the prior value intact, and a
   * reader never observes a partial value. Callers rely on this — the
   * materialization planner short-circuits on exists(key), so a key that exists
   * with truncated bytes never re-enters a plan and is corrupt forever.
   */
  put(key: string, data: Buffer): Promise<void>;
  /** Retrieve bytes by key. Returns null if not found. */
  get(key: string): Promise<Buffer | null>;
  /** Delete bytes by key. No-op if not found. */
  delete(key: string): Promise<void>;
  /** True if key exists. */
  exists(key: string): Promise<boolean>;
  /**
   * Byte length of the value at `key`, or null if absent (F0-05).
   *
   * Deliberately NOT `list()`: E-05 refused to add that before a second backend
   * existed to design it against, because listing semantics differ sharply
   * between a filesystem and an object store. Content-length does not — every
   * plausible backend has it and means the same thing by it.
   */
  size(key: string): Promise<number | null>;
}
