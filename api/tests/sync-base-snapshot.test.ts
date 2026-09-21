import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveBaseSnapshot, loadBaseSnapshot, deleteBaseSnapshot, baseSnapshotKey,
} from '../src/services/sync/base-snapshot.js';

const LINK_ID = '7d9a1f7e-0000-4000-8000-000000000abc';

describe('sync base-snapshot store', () => {
  let dir: string;
  let prevUploads: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weltbon-snap-'));
    prevUploads = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = dir;   // storageBackend resolves basePath per call
  });

  afterAll(() => {
    if (prevUploads === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploads;
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a payload through gzip', async () => {
    const payload = { universe: { id: 'u1', name: 'World' }, entries: [{ id: 'e1', title: 'T' }] };
    await saveBaseSnapshot(LINK_ID, payload);
    const loaded = await loadBaseSnapshot(LINK_ID);
    expect(loaded).toEqual(payload);
  });

  it('returns null when no snapshot exists', async () => {
    expect(await loadBaseSnapshot('7d9a1f7e-0000-4000-8000-00000000ffff')).toBeNull();
  });

  it('delete is idempotent and removes the snapshot', async () => {
    await saveBaseSnapshot(LINK_ID, { a: 1 });
    await deleteBaseSnapshot(LINK_ID);
    expect(await loadBaseSnapshot(LINK_ID)).toBeNull();
    await deleteBaseSnapshot(LINK_ID); // second call: no throw
  });

  it('key derivation is storage-safe (only [a-zA-Z0-9_-])', () => {
    expect(baseSnapshotKey(LINK_ID)).toMatch(/^sync-base-[a-zA-Z0-9-]+$/);
  });
});
