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
  constructor(private readonly basePath: string) {}

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

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? '/uploads';
export const storageBackend = new LocalStorageBackend(UPLOADS_DIR);
