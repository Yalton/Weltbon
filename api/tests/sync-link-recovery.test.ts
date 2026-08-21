/**
 * Issue #55 — sync-link-recovery.test.ts
 *
 * Integration-lane (DB-gated) tests for recoverOrphanSyncLinks.
 *
 * THE BUG THIS PINS. `claimLink` sets a link to status='syncing'
 * (services/sync/link-state.ts:63) and `runSync` returns it to 'idle' or
 * 'error' through `safeRelease` (services/sync/run-sync.ts:552,560). A run
 * INTERRUPTED between those two points — the process is killed, the container
 * restarts, the machine loses power — never reaches either release, so the row
 * stays 'syncing' forever.
 *
 * That matters beyond a wrong status string. #42's first-sync-failed banner
 * fires on `status === 'error' && lastSyncedAt === null`
 * (web/src/views/EntryList.tsx), so an interrupted FIRST sync leaves the user
 * in a universe that is empty, with no banner, no error and no retry — the
 * "indistinguishable from data loss" state the banner exists to prevent,
 * reached through a different door. Manual retry does not rescue them either:
 * `claimLink` refuses with SyncBusyError while the stale claim looks live.
 *
 * Pattern: mirrors api/tests/audit-recovery.test.ts, because this mirrors
 * AUDIT-12's recoverOrphanAuditRuns — the same boot-time orphan problem, for
 * a different table.
 *
 * Tests:
 *   1. Force-fails a 'syncing' row to error/process_restarted.
 *   2. Leaves lastSyncedAt untouched — load-bearing, it is half the banner's
 *      condition, so clobbering it would silently disarm the banner again.
 *   3. Leaves already-terminal rows ('idle', 'error') alone, preserving an
 *      existing lastError rather than overwriting the real cause.
 *   4. Idempotent: a second call returns 0.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { syncLinks, syncRemotes, universes } from '../src/db/schema.js';
import { encryptSecret } from '../src/services/crypto.js';

describe('recoverOrphanSyncLinks (issue #55)', () => {
  let handle: TestDbHandle;
  let recoverOrphanSyncLinks: (db: TestDbHandle['db']) => Promise<number>;

  beforeAll(async () => {
    handle = await createTestDb();
    const mod = await import('../src/services/sync/link-recovery.js');
    recoverOrphanSyncLinks = mod.recoverOrphanSyncLinks as (db: TestDbHandle['db']) => Promise<number>;
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  /** A link in whatever state the test needs, with its owning user/universe/remote. */
  async function seedLink(opts: {
    status: string;
    lastSyncedAt?: Date | null;
    lastError?: string | null;
  }): Promise<string> {
    const user = await createTestUser(handle, {
      email: `recovery-${Math.floor(performance.now() * 1000)}@example.com`,
      password: 'longenoughpw12',
    });
    const [universe] = await handle.db
      .insert(universes)
      .values({ userId: user.id, name: 'Interrupted Universe' })
      .returning({ id: universes.id });
    const [remote] = await handle.db
      .insert(syncRemotes)
      .values({
        userId: user.id,
        label: 'peer.example',
        baseUrl: 'https://peer.example',
        encryptedPat: encryptSecret('wbn_pat_x', '0'.repeat(64)),
      })
      .returning({ id: syncRemotes.id });
    const [link] = await handle.db
      .insert(syncLinks)
      .values({
        universeId: universe.id,
        remoteId: remote.id,
        status: opts.status,
        lastSyncedAt: opts.lastSyncedAt ?? null,
        lastError: opts.lastError ?? null,
      })
      .returning({ id: syncLinks.id });
    return link.id;
  }

  async function readLink(id: string) {
    const [row] = await handle.db.select().from(syncLinks).where(eq(syncLinks.id, id)).limit(1);
    return row;
  }

  it("force-fails an interrupted 'syncing' row to error/process_restarted", async () => {
    const id = await seedLink({ status: 'syncing' });

    const count = await recoverOrphanSyncLinks(handle.db);

    expect(count).toBe(1);
    const row = await readLink(id);
    expect(row.status).toBe('error');
    expect(row.lastError).toBe('process_restarted');
  });

  it('leaves lastSyncedAt untouched, so a never-synced link still reads as a failed FIRST sync', async () => {
    // Load-bearing: #42's banner condition is
    // `status === 'error' && lastSyncedAt === null`. If recovery stamped
    // lastSyncedAt it would disarm the very banner this fix exists to arm.
    const neverSynced = await seedLink({ status: 'syncing', lastSyncedAt: null });
    const syncedBefore = new Date('2026-01-01T00:00:00.000Z');
    const hadSynced = await seedLink({ status: 'syncing', lastSyncedAt: syncedBefore });

    await recoverOrphanSyncLinks(handle.db);

    expect((await readLink(neverSynced)).lastSyncedAt).toBeNull();
    expect((await readLink(hadSynced)).lastSyncedAt).toEqual(syncedBefore);
  });

  it('leaves already-terminal rows alone and preserves their real lastError', async () => {
    const idle = await seedLink({ status: 'idle', lastError: null });
    const errored = await seedLink({ status: 'error', lastError: 'the peer refused the connection' });

    const count = await recoverOrphanSyncLinks(handle.db);

    expect(count).toBe(0);
    expect((await readLink(idle)).status).toBe('idle');
    const stillErrored = await readLink(errored);
    expect(stillErrored.status).toBe('error');
    // Not overwritten with 'process_restarted' — the real cause survives.
    expect(stillErrored.lastError).toBe('the peer refused the connection');
  });

  it('is idempotent — a second call finds nothing left to recover', async () => {
    await seedLink({ status: 'syncing' });

    expect(await recoverOrphanSyncLinks(handle.db)).toBe(1);
    expect(await recoverOrphanSyncLinks(handle.db)).toBe(0);
  });
});
