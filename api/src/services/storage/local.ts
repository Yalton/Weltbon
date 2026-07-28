/**
 * Phase 38 MEDIA-01 (D-01): Local-filesystem StorageBackend implementation.
 *
 * Stores asset bytes under a configurable base directory (UPLOADS_DIR env var,
 * defaulting to '/uploads' — the Docker volume mount point). All byte I/O uses
 * node:fs/promises (same Node.js async I/O idiom as ingest-zip.ts).
 *
 * Security (T-38-01): safeJoin() strips every character that is not alphanumeric,
 * underscore, or dash before joining with basePath. This prevents path-traversal
 * attacks even if a non-UUID key is somehow passed — only UUID-shaped strings
 * (hex + dashes) pass through unchanged, and any key that reduces to empty
 * throws an Error before touching the filesystem.
 *
 * Volume path: /uploads (NOT /app/assets — that path is already used for PDF font
 * files mounted at /repo/api/assets in the Dockerfile).
 *
 * Atomicity (F0-03): put() writes to `<key>.tmp-<16 hex>` in this same directory
 * and renames it into place. Two consequences. Temp names are unaddressable
 * through the API — safeJoin strips '.', so no key can resolve to one. And a
 * hard process kill between the write and the rename orphans a temp file with
 * nothing to reclaim it; there is no sweeper. If one is ever added, `*.tmp-`
 * followed by 16 hex chars is the pattern, and anything older than a run is safe
 * to remove.
 */

import { mkdir, readFile, writeFile, unlink, access, rename, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { StorageBackend } from './interface.js';

export class LocalStorageBackend implements StorageBackend {
  /**
   * Optional explicit base directory. When omitted (the singleton case), the
   * base path is resolved LAZILY from process.env.UPLOADS_DIR at each I/O call
   * rather than captured at construction time.
   *
   * Rationale: ES modules hoist `import` statements above all other top-level
   * code, so a consumer that sets process.env.UPLOADS_DIR before importing this
   * module still runs that assignment AFTER this module is evaluated. Capturing
   * the env var in the constructor would therefore ignore the override (and, in
   * tests, attempt to mkdir the production `/uploads` mount → EACCES). Reading it
   * lazily makes the singleton honor UPLOADS_DIR whenever it is set.
   */
  constructor(private readonly explicitBasePath?: string) {}

  private get basePath(): string {
    return this.explicitBasePath ?? process.env.UPLOADS_DIR ?? '/uploads';
  }

  async put(key: string, data: Buffer): Promise<void> {
    const fullPath = this.safeJoin(key);
    await mkdir(this.basePath, { recursive: true });

    // F0-03: write to a temp path, then rename. A POSIX same-filesystem rename
    // is atomic, so a reader sees either the whole old value or the whole new
    // one — never the truncated file a bare writeFile leaves behind, which
    // exists() would then report as present forever.
    //
    // The temp path is built from the ALREADY-JOINED path, never by passing a
    // decorated key back through safeJoin. safeJoin strips every character
    // outside [a-zA-Z0-9_-], so a suffix composed only of stripped characters
    // would reduce to the real key itself — making the temp path identical to
    // the destination and turning this write back into the truncating one it
    // exists to replace.
    //
    // The random component is not decoration: two concurrent puts of one key
    // sharing a temp path would interleave their bytes into it and then each
    // rename the mixture into place.
    //
    // The temp path is a SIBLING of the destination, not a file in os.tmpdir().
    // That is what makes the rename same-filesystem and therefore atomic —
    // rename(2) returns EXDEV across mounts and Node does not fall back to
    // copy. Do not relocate the temp file.
    const tmpPath = `${fullPath}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(tmpPath, data);
      await rename(tmpPath, fullPath);
    } catch (err) {
      // Best-effort: never let cleanup replace the real error.
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.safeJoin(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.safeJoin(key));
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // No-op on missing key — idempotent delete per interface contract
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.safeJoin(key));
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number | null> {
    try {
      const st = await stat(this.safeJoin(key));
      return st.size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Path-traversal guard (T-38-01).
   *
   * UUIDs only pass through here (validated at upload time), but defense-in-depth:
   * strip every char that isn't alphanumeric, dash, or underscore so that even a
   * crafted key cannot escape the basePath via ../ sequences or absolute paths.
   * Throws on an empty result (key reduced to nothing after stripping).
   */
  private safeJoin(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!safe) throw new Error('Invalid storage key');
    return join(this.basePath, safe);
  }
}

// Singleton: no explicit base path → resolves UPLOADS_DIR lazily per I/O call
// (defaults to the /uploads Docker volume mount). See constructor doc above.
export const storageBackend = new LocalStorageBackend();
