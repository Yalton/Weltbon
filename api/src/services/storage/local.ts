
import { mkdir, readFile, writeFile, unlink, access, rename, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { StorageBackend } from './interface.js';

export class LocalStorageBackend implements StorageBackend {
  constructor(private readonly explicitBasePath?: string) {}

  private get basePath(): string {
    return this.explicitBasePath ?? process.env.UPLOADS_DIR ?? '/uploads';
  }

  async put(key: string, data: Buffer): Promise<void> {
    const fullPath = this.safeJoin(key);
    await mkdir(this.basePath, { recursive: true });

    // A random sibling temp path makes rename atomic and cleanup safe for concurrent writers.
    const tmpPath = `${fullPath}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      await writeFile(tmpPath, data);
      await rename(tmpPath, fullPath);
    } catch (err) {
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

  private safeJoin(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_\-]/g, '');
    if (!safe) throw new Error('Invalid storage key');
    return join(this.basePath, safe);
  }
}

export const storageBackend = new LocalStorageBackend();
