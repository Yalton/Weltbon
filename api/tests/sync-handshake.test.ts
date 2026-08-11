/**
 * Plan C Task 4 — the C-14 journal-unavailable branch (pure unit, no DB).
 *
 * C-14 requires that an unreadable migration journal fails LOUDLY: migrationHead()
 * throws MigrationHeadUnavailableError, and the handshake handler maps that to 503
 * rather than a permissive default that would let mismatched instances sync.
 *
 * migrationHead()'s cache is process-global, so any sibling test in this worker
 * that calls localIdentity() warms it and would hide the cold-read failure this
 * file needs. The beforeEach/afterEach resetMigrationHeadCache() (plus restoring
 * DRIZZLE_DIR) is what actually isolates it — not the file boundary — and also
 * keeps this file from poisoning a sibling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrationHead,
  localIdentity,
  MigrationHeadUnavailableError,
  resetMigrationHeadCache,
} from '../src/services/sync/handshake.js';
import { syncRoutes } from '../src/routes/sync.js';

describe('sync handshake — migration head unavailable (C-14)', () => {
  const originalDir = process.env.DRIZZLE_DIR;
  let tempDirs: string[] = [];

  beforeEach(() => {
    resetMigrationHeadCache();
  });

  afterEach(async () => {
    if (originalDir === undefined) delete process.env.DRIZZLE_DIR;
    else process.env.DRIZZLE_DIR = originalDir;
    resetMigrationHeadCache();
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    tempDirs = [];
  });

  async function tempDir(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), 'weltbon-journal-'));
    tempDirs.push(d);
    return d;
  }

  it('rejects with MigrationHeadUnavailableError when the journal file is missing', async () => {
    process.env.DRIZZLE_DIR = await tempDir(); // no meta/_journal.json inside
    await expect(migrationHead()).rejects.toBeInstanceOf(MigrationHeadUnavailableError);
  });

  it('rejects with MigrationHeadUnavailableError when the journal has no entries', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'meta'), { recursive: true });
    await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [] }), 'utf8');
    process.env.DRIZZLE_DIR = dir;
    await expect(migrationHead()).rejects.toBeInstanceOf(MigrationHeadUnavailableError);
  });

  it('localIdentity() propagates the failure rather than defaulting', async () => {
    process.env.DRIZZLE_DIR = await tempDir();
    await expect(localIdentity()).rejects.toBeInstanceOf(MigrationHeadUnavailableError);
  });

  it('the handshake handler maps an unavailable journal to 503 (C-14)', async () => {
    process.env.DRIZZLE_DIR = await tempDir(); // journal unreadable → migrationHead throws
    // Call the router directly; the handshake handler needs no DB and no auth
    // (the auth gate is mounted in index.ts, not on syncRoutes). A valid body
    // passes zod validation so the handler runs and its catch branch fires.
    const res = await syncRoutes.request('/handshake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instanceId: '11111111-1111-4111-8111-111111111111',
        weltbonVersion: '2.2.0',
        migrationHead: 'anything',
      }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/migration head/i);
  });
});
