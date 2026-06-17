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
 */

import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
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
    await writeFile(fullPath, data);
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
