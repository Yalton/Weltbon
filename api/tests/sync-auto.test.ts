/**
 * Issue #44 Task 6 — the auto-sync scheduler, driven against a real peer.
 *
 * Same two-instance shape as tests/sync-run.test.ts (A and B are two
 * INSTANCES: two databases, two users, two blob stores, one shared universe
 * id), because the only interesting question about the scheduler is what it
 * does to a REAL sync run — a mocked runSync would prove nothing about
 * coalescing, backoff or convergence.
 *
 * NO TIMERS. `tick(now)` is public precisely so a test can advance the
 * scheduler one step at a time and assert in between; nothing here sleeps,
 * and the clock is a plain mutable Date the scheduler is handed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// CRITICAL — must be set BEFORE the *first* env() call in the process. See
// tests/sync-run.test.ts for the full story: config.ts memoizes on first
// env() call, import declarations are hoisted above top-level code, and the
// integration lane runs every DB-gated file in one shared process
// (singleFork) — so this MUST be vi.hoisted AND MUST use the exact literal
// '0'.repeat(64) shared by every other DB-gated file.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import {
  createScheduler,
  type Scheduler,
  type SchedulerOptions,
} from '../src/services/sync/scheduler.js';
import { MAX_PENDING_TICKS, STABLE_TICKS_REQUIRED } from '../src/services/sync/schedule.js';
import type { FetchLike } from '../src/services/sync/remote-client.js';

/**
 * Ticks that reliably carry one settled local change all the way to a run:
 * the tick that first observes the change, then STABLE_TICKS_REQUIRED ticks
 * of stability, plus slack for a tick spent polling the peer. Extra ticks
 * after the run are harmless — the clock does not advance, so nextPollAt
 * stays in the future and every following tick is idle.
 */
const SETTLE_TICKS = STABLE_TICKS_REQUIRED + 3;

describe('auto-sync scheduler (#44)', () => {
  let A: TestDbHandle;
  let B: TestDbHandle;
  let uploadsA: string;
  let uploadsB: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let ownerA: { id: string; email: string };
  let ownerB: { id: string; email: string };
  let tokenA: string;
  let tokenB: string;
  let universeId: string;
  let linkId: string;
  /** Set by a test to run a write in the middle of a sync. See peerFetch. */
  let duringSnapshot: (() => Promise<void>) | null = null;

  /** The scheduler's clock. Advanced by assignment, never by a real timer. */
  let clock: Date;
  /** 'down' throws at the transport; 'unauthorized' answers 401 to everything. */
  let peerMode: 'up' | 'down' | 'unauthorized' | 'no-fingerprint-endpoint';
  /**
   * How many sync RUNS the scheduler has started. Counted at the transport,
   * on POST /handshake — the first request every run makes and one no poll
   * ever makes, so it separates "the scheduler ran a sync" from "the
   * scheduler probed a fingerprint" without a spy inside runSync.
   */
  let handshakes: number;

  beforeAll(async () => {
    uploadsA = await mkdtemp(join(tmpdir(), 'weltbon-auto-a-'));
    uploadsB = await mkdtemp(join(tmpdir(), 'weltbon-auto-b-'));
    A = await createTestDb();
    B = await createTestDb();
    if (process.env.WELTBON_TEST_DRIVER !== 'pglite') {
      expect(A.schemaName).not.toBe(B.schemaName);
    }
    expect(A.db).not.toBe(B.db);
    app = (await import('../src/index.js')).createApp();
  });

  afterAll(async () => {
    await A.cleanup();
    await B.cleanup();
  });

  async function use(which: 'A' | 'B'): Promise<void> {
    const { setTestDb } = await import('../src/db/client.js');
    const handle = which === 'A' ? A : B;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);
    process.env.UPLOADS_DIR = which === 'A' ? uploadsA : uploadsB;
  }

  async function login(email: string): Promise<string> {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password123' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).accessToken;
  }

  async function mintPat(handle: TestDbHandle, userId: string): Promise<string> {
    const { generatePatToken } = await import('../src/services/pat.js');
    const { personalAccessTokens } = await import('../src/db/schema.js');
    const { plaintext, hash, bodySuffix } = generatePatToken();
    await handle.db.insert(personalAccessTokens).values({ userId, label: 'peer', hash, bodySuffix });
    return plaintext;
  }

  async function createRemoteAndLink(patPlaintext: string): Promise<string> {
    const { encryptSecret } = await import('../src/services/crypto.js');
    const { syncRemotes, syncLinks } = await import('../src/db/schema.js');
    const [remote] = await A.db
      .insert(syncRemotes)
      .values({
        userId: ownerA.id,
        label: 'peer B',
        baseUrl: 'https://peer.example',
        encryptedPat: encryptSecret(patPlaintext, '0'.repeat(64)),
      })
      .returning();
    const [link] = await A.db.insert(syncLinks).values({ universeId, remoteId: remote.id }).returning();
    return link.id;
  }

  /**
   * The injected peer transport (D-05), plus the two peer faults this suite
   * needs. Flips the shared app to B for the call and back to A in a
   * `finally`, so a scheduler mid-run on A never finds the app pointed at B.
   */
  function peerFetch(): FetchLike {
    return async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      const path = u.pathname + u.search;
      if (path.endsWith('/handshake')) handshakes += 1;
      // The mid-run injection point (#61). drive() calls handshake, THEN
      // buildSyncManifest, THEN snapshot — so a write made while the snapshot
      // request is in flight lands strictly after the manifest was built, which
      // is exactly the window the fix is about. Fires once.
      if (path.includes('/snapshot') && duringSnapshot !== null) {
        const hook = duringSnapshot;
        duringSnapshot = null;
        await hook();
      }
      if (peerMode === 'down') {
        // What an offline peer actually looks like to fetch(): a rejected
        // promise, not a status code.
        throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
      }
      // A peer too old to have the fingerprint endpoint: 404 there, healthy
      // everywhere else. Indistinguishable from a deleted universe at the
      // probe, which is the whole difficulty in #62.
      if (peerMode === 'no-fingerprint-endpoint' && path.includes('/fingerprint')) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (peerMode === 'unauthorized') {
        return new Response(JSON.stringify({ error: 'invalid token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      await use('B');
      try {
        return await app.request(path, init);
      } finally {
        await use('A');
      }
    };
  }

  /**
   * `startupStaggerMs: 0` switches OFF the first-boot stagger for every test
   * that is not about it. The stagger holds a link the process has never seen
   * before until a jittered instant inside the next poll interval — correct in
   * production, and fatal here, where `clock` never advances on its own: every
   * link would be held for the whole test. The two tests that DO exercise it
   * pass a real window and move the clock themselves.
   */
  function mk(over: Partial<SchedulerOptions> = {}): Scheduler {
    return createScheduler({
      now: () => clock,
      fetchImpl: peerFetch(),
      startupStaggerMs: 0,
      ...over,
    });
  }

  const runsStarted = () => handshakes;

  /**
   * Tick until exactly one more run has completed, then stop. `tickN(SETTLE_TICKS)`
   * is too coarse for the #61 tests: the whole point of the fix is that a second
   * run follows on its own, so a fixed batch of ticks can contain both runs and
   * hide which one carried what.
   */
  /**
   * Tick with the clock moving past the poll interval each time, so
   * `nextPollAt` actually comes due and the scheduler issues a remote probe.
   * Plain `tickN` holds the clock still, which is right for the debounce tests
   * but means a poll NEVER fires — a #62 test run that way passes without ever
   * reaching the code it is meant to cover.
   */
  async function tickPolling(sched: Scheduler, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      clock = new Date(clock.getTime() + 61_000); // > DEFAULT_POLL_MS
      await use('A');
      await sched.tick(clock);
    }
  }

  async function tickUntilRun(sched: Scheduler, cap = 20): Promise<void> {
    const before = runsStarted();
    for (let i = 0; i < cap; i += 1) {
      await use('A');
      await sched.tick(clock);
      if (runsStarted() > before) return;
    }
    throw new Error(`no run completed within ${cap} ticks`);
  }

  async function tickN(sched: Scheduler, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await use('A');
      await sched.tick(clock);
    }
  }

  async function linkRow() {
    const { syncLinks } = await import('../src/db/schema.js');
    const [row] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, linkId));
    return row;
  }

  const token = (which: 'A' | 'B') => (which === 'A' ? tokenA : tokenB);

  async function seedEntry(which: 'A' | 'B', title: string) {
    await use(which);
    const res = await app.request(`/api/universes/${universeId}/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token(which)) },
      body: JSON.stringify({ title, entryType: 'concept', summary: `${title} summary` }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    await use('A');
    return created;
  }

  async function entryTitles(which: 'A' | 'B'): Promise<string[]> {
    const handle = which === 'A' ? A : B;
    const { entries } = await import('../src/db/schema.js');
    const rows = await handle.db
      .select({ title: entries.title })
      .from(entries)
      .where(eq(entries.universeId, universeId));
    return rows.map((r) => r.title).sort();
  }

  beforeEach(async () => {
    clock = new Date();
    peerMode = 'up';
    handshakes = 0;
    duringSnapshot = null;

    await use('A');
    await cleanDb(A);
    ownerA = await createTestUser(A, { email: 'a@instance.dev', password: 'password123' });
    tokenA = await login('a@instance.dev');
    const { universes } = await import('../src/db/schema.js');
    const [u] = await A.db.insert(universes).values({ userId: ownerA.id, name: 'Shared World' }).returning();
    universeId = u.id;

    await use('B');
    await cleanDb(B);
    ownerB = await createTestUser(B, { email: 'b@instance.dev', password: 'password123' });
    tokenB = await login('b@instance.dev');
    const patPlaintext = await mintPat(B, ownerB.id);

    await use('A');
    linkId = await createRemoteAndLink(patPlaintext);
  });

  // ── 1. coalescing ─────────────────────────────────────────────────────────

  it('coalesces a burst of local edits into ONE run', async () => {
    const sched = mk();

    await seedEntry('A', 'a');
    await sched.tick(clock); // fingerprint moved
    await seedEntry('A', 'b');
    await sched.tick(clock); // moved again — resets the stability window
    await seedEntry('A', 'c');
    await sched.tick(clock);
    expect(runsStarted()).toBe(0); // still settling

    await sched.tick(clock); // held still: 1
    await sched.tick(clock); // held still: 2 → runs
    expect(runsStarted()).toBe(1);
    expect(await entryTitles('B')).toEqual(['a', 'b', 'c']);

    // THE reset assertion. After a successful run the scheduler must both
    // record the post-run local fingerprint AND clear this link's in-memory
    // debounce window. Skip either and `decide()` keeps returning run/local on
    // every tick that follows, forever, on a universe nobody touched again.
    await tickN(sched, 5);
    expect(runsStarted()).toBe(1);
  });

  // ── 2. a change on the peer ───────────────────────────────────────────────

  it('picks up a change made on the peer', async () => {
    const sched = mk();
    await seedEntry('A', 'local-seed');
    await tickN(sched, SETTLE_TICKS);
    expect(runsStarted()).toBe(1);

    await seedEntry('B', 'remote-title');
    // Past nextPollAt, which the successful run pushed one poll interval out.
    clock = new Date(clock.getTime() + 5 * 60_000);
    await tickN(sched, 1); // the poll sees a new remote fingerprint and runs
    expect(runsStarted()).toBe(2);
    expect(await entryTitles('A')).toEqual(['local-seed', 'remote-title']);

    // Converged: the next poll window must not find "a remote change" in the
    // peer state this run itself produced.
    clock = new Date(clock.getTime() + 5 * 60_000);
    await tickN(sched, 2);
    expect(runsStarted()).toBe(2);
  });

  // ── 3. unreachable peer: backoff, then unattended recovery ────────────────

  it('backs off while the peer is unreachable, then recovers with no user action', async () => {
    const sched = mk();
    peerMode = 'down';
    await seedEntry('A', 'x');
    await tickN(sched, SETTLE_TICKS);

    const failed = await linkRow();
    // EXACTLY one, not "at least one". The count is what pins the runtime's
    // backoff gate: the first tick's poll fails and records failure 1, and
    // every tick after it must be skipped entirely until the recorded backoff
    // elapses. Delete the gate and decide() returns run/local on each of the
    // remaining ticks, every one of them attempting a handshake against a dead
    // peer — the count reaches 4 here and would climb without bound in
    // production. `toBeGreaterThanOrEqual(1)` passes in both worlds, which is
    // why it is not allowed to stand.
    expect(failed.failureCount).toBe(1);
    expect(failed.nextPollAt).not.toBeNull();
    expect(failed.nextPollAt!.getTime()).toBeGreaterThan(clock.getTime());
    // Unreachable is NOT a pause: a closed laptop must not permanently stop a
    // link, because only a human can clear a pause.
    expect(failed.pausedReason).toBeNull();

    peerMode = 'up';
    clock = new Date(failed.nextPollAt!.getTime() + 1);
    await tickN(sched, SETTLE_TICKS);

    const recovered = await linkRow();
    expect(recovered.failureCount).toBe(0);
    expect(recovered.pausedReason).toBeNull();
    expect(await entryTitles('B')).toEqual(['x']);
  });

  // ── 4. rejected credentials: pause, and really stop ───────────────────────

  it('pauses the link on rejected credentials and stops trying', async () => {
    const sched = mk();
    peerMode = 'unauthorized';
    await seedEntry('A', 'y');
    await tickN(sched, SETTLE_TICKS);

    expect((await linkRow()).pausedReason).toBe('remote-unauthorized');

    const before = runsStarted();
    peerMode = 'up'; // even with the peer healthy again, a pause needs a human
    clock = new Date(clock.getTime() + 60 * 60 * 1000);
    await tickN(sched, SETTLE_TICKS);
    expect(runsStarted()).toBe(before);
    expect((await linkRow()).pausedReason).toBe('remote-unauthorized');
  });

  // ── 5. simultaneous edits are a conflict, not a failure ───────────────────

  it('records conflicts from simultaneous edits and still counts the run a success', async () => {
    const sched = mk();
    const created = await seedEntry('A', 'Contested');
    await tickN(sched, SETTLE_TICKS); // bootstrap
    expect(runsStarted()).toBe(1);

    const { entries, syncConflicts } = await import('../src/db/schema.js');
    // Deterministic winner: explicit timestamps, not a clock race.
    await A.db
      .update(entries)
      .set({ summary: 'A loses', updatedAt: new Date('2026-06-01T00:00:00.000Z') })
      .where(eq(entries.id, created.id));
    await B.db
      .update(entries)
      .set({ summary: 'B wins', updatedAt: new Date('2026-06-02T00:00:00.000Z') })
      .where(eq(entries.id, created.id));

    await tickN(sched, SETTLE_TICKS);

    const rows = await A.db
      .select()
      .from(syncConflicts)
      .where(eq(syncConflicts.universeId, universeId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].winner).toBe('remote');

    const link = await linkRow();
    expect(link.pausedReason).toBeNull();
    expect(link.failureCount).toBe(0);
  });

  // ── 6. contention is not failure ──────────────────────────────────────────

  it('skips a link whose universe is already syncing, without counting a failure', async () => {
    const sched = mk();
    const { claimLink, releaseLink } = await import('../src/services/sync/link-state.js');
    await seedEntry('A', 'z');

    await use('A');
    await claimLink(linkId); // somebody else holds the lease
    try {
      await tickN(sched, SETTLE_TICKS);
    } finally {
      await use('A');
      await releaseLink(linkId, { status: 'idle' });
    }

    const link = await linkRow();
    // SyncBusyError's policy is 'skip' (AS-08): no counter, no backoff, and
    // nothing a user is ever shown.
    expect(link.failureCount).toBe(0);
    expect(link.pausedReason).toBeNull();
    expect(runsStarted()).toBe(0); // claimLink refuses before any request goes out
  });

  // ── 7. the per-link toggle ────────────────────────────────────────────────

  it('ignores a link with auto-sync off', async () => {
    const sched = mk();
    const { syncLinks } = await import('../src/db/schema.js');
    await A.db.update(syncLinks).set({ autoSync: false }).where(eq(syncLinks.id, linkId));

    await seedEntry('A', 'w');
    await tickN(sched, SETTLE_TICKS);
    expect(runsStarted()).toBe(0);
    expect(await entryTitles('B')).toEqual([]);
  });

  // ── 8. restart ────────────────────────────────────────────────────────────

  it('resumes correctly after a restart, from sync_links alone', async () => {
    const first = mk();
    await seedEntry('A', 'persisted');
    await tickN(first, SETTLE_TICKS);
    expect(runsStarted()).toBe(1);
    expect((await linkRow()).lastSyncedFingerprint).not.toBeNull();

    // A brand-new scheduler shares no memory with the first — the debounce
    // window is deliberately not persisted (AS-05).
    const second = mk();
    const before = runsStarted();
    await tickN(second, 2);
    expect(runsStarted()).toBe(before); // nothing changed, so nothing runs
  });

  // ── 9. the debounce window starts over after a run ────────────────────────

  it('starts a fresh debounce window after a run, so the next burst still coalesces', async () => {
    const sched = mk();
    await seedEntry('A', 'first');
    await tickN(sched, SETTLE_TICKS);
    expect(runsStarted()).toBe(1);

    // schedule.ts's `pendingTicks` never resets itself — nextDebounce
    // increments it on EVERY tick, including ticks where nothing at all is
    // waiting to sync. Left alone it climbs past MAX_PENDING_TICKS while the
    // link sits idle, and the next edit would then bypass coalescing entirely
    // and sync on the first keystroke of every burst.
    await tickN(sched, MAX_PENDING_TICKS + 2);
    expect(runsStarted()).toBe(1);

    await seedEntry('A', 'second');
    await tickN(sched, 1);
    expect(runsStarted()).toBe(1); // still settling, exactly as on a fresh link
    await tickN(sched, SETTLE_TICKS);
    expect(runsStarted()).toBe(2);
    expect(await entryTitles('B')).toEqual(['first', 'second']);
  });

  // ── 10. a successful run clears the pause and the backoff ────────────────

  describe('a successful run clears the auto-sync failure state (AS-08)', () => {
    async function forceFailureState(over: {
      pausedReason?: string | null;
      failureCount?: number;
      nextPollAt?: Date | null;
    }): Promise<void> {
      const { syncLinks } = await import('../src/db/schema.js');
      await use('A');
      await A.db.update(syncLinks).set(over).where(eq(syncLinks.id, linkId));
    }

    async function manualRun(): Promise<void> {
      const { runSync } = await import('../src/services/sync/run-sync.js');
      await use('A');
      await runSync(linkId, ownerA.id, { fetchImpl: peerFetch() });
    }

    it('a MANUAL run clears pausedReason — the remedy the paused row names', async () => {
      // The exact trap this fix exists for: a PAT expires, the scheduler pauses
      // the link with `remote-unauthorized`, and the status line tells the user
      // to sign in again and save a fresh token. They do, they press "Sync
      // now", the run succeeds — and before this fix the row still said Paused
      // and auto-sync never resumed, because the ONLY code that cleared
      // paused_reason was the scheduler's own post-run UPDATE and the auto-sync
      // toggle. Pausing does not set auto_sync = false, so the only working
      // escape was unchecking and re-checking a box that was already checked.
      await seedEntry('A', 'written-while-paused');
      await forceFailureState({
        pausedReason: 'remote-unauthorized',
        failureCount: 3,
        nextPollAt: new Date(clock.getTime() + 30 * 60_000),
      });

      await manualRun();

      const link = await linkRow();
      expect(link.pausedReason).toBeNull();
      expect(link.failureCount).toBe(0);
      expect(link.nextPollAt).toBeNull();
      // ...and it was a real sync, not just a state reset.
      expect(await entryTitles('B')).toEqual(['written-while-paused']);
    });

    it('a MANUAL run ends a real backoff, instead of leaving "Retrying in 30m" on a link just synced', async () => {
      // The streak is genuine, not injected: ticks against a dead peer.
      const sched = mk();
      peerMode = 'down';
      await seedEntry('A', 'stranded');
      await tickN(sched, SETTLE_TICKS);

      const failing = await linkRow();
      expect(failing.failureCount).toBeGreaterThan(0);
      expect(failing.nextPollAt!.getTime()).toBeGreaterThan(clock.getTime());

      // The user stops waiting and presses "Sync now". The peer is back.
      peerMode = 'up';
      await manualRun();

      // failure_count resets on ANY successful run, including a manual one
      // (AS-08). Without this the scheduler goes on skipping the link for the
      // rest of the backoff window — up to half an hour — and syncStatusCopy,
      // which checks failureCount BEFORE lastSyncedAt, renders "Retrying in
      // 30m" on a link the user just synced by hand.
      const recovered = await linkRow();
      expect(recovered.failureCount).toBe(0);
      expect(recovered.nextPollAt).toBeNull();

      // And auto-sync picks the link straight back up rather than skipping it
      // until a window it is no longer inside expires.
      const before = runsStarted();
      await seedEntry('A', 'after-manual');
      await tickN(sched, SETTLE_TICKS);
      expect(runsStarted()).toBeGreaterThan(before);
      expect(await entryTitles('B')).toEqual(['after-manual', 'stranded']);
    });

    it('a FAILED run leaves the pause alone', async () => {
      // The clear is bound to success, not to "a run happened". A run that
      // fails against the same rejected credentials must not unpause the link
      // and hand it back to the scheduler to fail again every tick.
      await seedEntry('A', 'still-stuck');
      await forceFailureState({ pausedReason: 'remote-unauthorized', failureCount: 3 });
      peerMode = 'unauthorized';

      const { runSync } = await import('../src/services/sync/run-sync.js');
      await use('A');
      await expect(runSync(linkId, ownerA.id, { fetchImpl: peerFetch() })).rejects.toThrow();

      const link = await linkRow();
      expect(link.pausedReason).toBe('remote-unauthorized');
      expect(link.failureCount).toBe(3);
    });
  });

  // ── mid-run edits (#61) ───────────────────────────────────────────────────

  describe('an edit that lands mid-run is not recorded as synced (#61)', () => {
    /**
     * The failure this pins: `lastSyncedFingerprint` was captured AFTER the run,
     * so an edit made while the run was in flight — never in the manifest that
     * went to the peer — was folded in as though it had been pushed. The link
     * then looked settled, and on a link nothing else ever touches it stayed
     * that way, so the edit never reached the peer at all.
     */
    it('leaves the mid-run edit visible as unsynced work rather than folding it in', async () => {
      await seedEntry('A', 'first');

      // Land a second entry while the run is mid-flight, straight into the DB
      // so it does not disturb the shared app pointer.
      duringSnapshot = async () => {
        const { entries } = await import('../src/db/schema.js');
        await A.db.insert(entries).values({
          universeId,
          title: 'written-mid-run',
          entryType: 'concept',
          summary: 'landed after the manifest was built',
        });
      };

      const sched = mk();
      await tickUntilRun(sched);

      // The run happened and pushed what it had.
      expect(await entryTitles('B')).toEqual(['first']);
      // ...and the entry that arrived mid-run is on A but not on B.
      expect(await entryTitles('A')).toEqual(['first', 'written-mid-run']);

      // The assertion that matters: the link must NOT claim the current local
      // state is synced, because it is not.
      const { universeFingerprint } = await import('../src/services/sync/fingerprint.js');
      await use('A');
      const link = await linkRow();
      expect(link.lastSyncedFingerprint).not.toBe(await universeFingerprint(universeId));
    });

    it('carries that edit to the peer on the following run, without another edit to prompt it', async () => {
      await seedEntry('A', 'first');
      duringSnapshot = async () => {
        const { entries } = await import('../src/db/schema.js');
        await A.db.insert(entries).values({
          universeId,
          title: 'written-mid-run',
          entryType: 'concept',
          summary: 'landed after the manifest was built',
        });
      };

      const sched = mk();
      await tickUntilRun(sched);
      expect(await entryTitles('B')).toEqual(['first']);

      // No new edit, no peer change — nothing but time. Before the fix this
      // link was inert and 'written-mid-run' never moved.
      await tickUntilRun(sched);

      expect(await entryTitles('B')).toEqual(['first', 'written-mid-run']);
      const { universeFingerprint } = await import('../src/services/sync/fingerprint.js');
      await use('A');
      const link = await linkRow();
      expect(link.lastSyncedFingerprint).toBe(await universeFingerprint(universeId));
    });

    it('still settles a quiet link, so the detection cannot cause a permanent sync loop', async () => {
      // The mirror risk of the fix: if a run that applies nothing always looked
      // like a mid-run edit, every link would sync forever. Nothing is injected
      // here, so the fingerprints must match and the link must go quiet.
      await seedEntry('A', 'only');

      const sched = mk();
      await tickN(sched, SETTLE_TICKS);
      const runsAfterFirst = runsStarted();

      await tickN(sched, 6);

      expect(runsStarted()).toBe(runsAfterFirst);
      const { universeFingerprint } = await import('../src/services/sync/fingerprint.js');
      await use('A');
      const link = await linkRow();
      expect(link.lastSyncedFingerprint).toBe(await universeFingerprint(universeId));
    });
  });

  // ── a universe deleted on the peer (#62) ─────────────────────────────────

  describe('a universe deleted on the peer is adjudicated, not probed forever (#62)', () => {
    /** Drop the universe on B, the way deleting it in that instance's UI would. */
    async function deleteUniverseOnPeer(): Promise<void> {
      const { universes } = await import('../src/db/schema.js');
      await B.db.delete(universes).where(eq(universes.id, universeId));
    }

    it('pauses the link with remote-universe-missing instead of polling a dead peer', async () => {
      // Establish the link properly first: severance is only meaningful once a
      // base snapshot exists, which is what distinguishes "deleted" from
      // "never pushed".
      await seedEntry('A', 'before-the-delete');
      const sched = mk();
      await tickN(sched, SETTLE_TICKS);
      expect(await entryTitles('B')).toEqual(['before-the-delete']);

      await deleteUniverseOnPeer();

      // No local edit — nothing but polling. Before the fix this looped
      // forever: the probe 404s, null is not a change, decide() returns
      // poll-remote again, and the link never reached an adjudication.
      await tickPolling(sched, 3);

      const link = await linkRow();
      expect(link.pausedReason).toBe('remote-universe-missing');
    });

    it('does not pause a peer that merely lacks the fingerprint endpoint', async () => {
      // The ambiguity the fix must not get wrong: same 404, universe intact.
      await seedEntry('A', 'before');
      const sched = mk();
      await tickN(sched, SETTLE_TICKS);
      expect(await entryTitles('B')).toEqual(['before']);

      peerMode = 'no-fingerprint-endpoint';
      const runsBefore = runsStarted();
      await tickPolling(sched, 3);

      const link = await linkRow();
      expect(link.pausedReason).toBeNull();
      // Proves the probe path was actually reached: a 404 forced exactly one
      // run. Without this the assertion above would also pass on a test that
      // never polled at all.
      expect(runsStarted()).toBe(runsBefore + 1);
    });

    it('still syncs local edits to a peer that lacks the fingerprint endpoint', async () => {
      await seedEntry('A', 'before');
      const sched = mk();
      await tickN(sched, SETTLE_TICKS);

      peerMode = 'no-fingerprint-endpoint';
      await seedEntry('A', 'after');
      await tickPolling(sched, SETTLE_TICKS);

      // Auto-sync degrades to local-edit-driven, rather than stopping.
      expect(await entryTitles('B')).toEqual(['after', 'before']);
    });

    it('forces only ONE run per 404 episode, not one per poll', async () => {
      // The cost control. Without the guard, an old peer would get a full
      // handshake-and-snapshot every single poll interval forever.
      await seedEntry('A', 'before');
      const sched = mk();
      await tickN(sched, SETTLE_TICKS);

      peerMode = 'no-fingerprint-endpoint';
      const runsBefore = runsStarted();
      await tickPolling(sched, 2);
      const afterFirstProbe = runsStarted();
      // The episode really did force its one run.
      expect(afterFirstProbe).toBe(runsBefore + 1);

      // Ten more polls, no local edits: the probe must not keep forcing runs.
      await tickPolling(sched, 10);

      expect(runsStarted()).toBe(afterFirstProbe);
    });
  });

  // ── 11. fairness: the tick budget must not starve the tail ───────────────

  describe('the tick budget rotates (FIX 3)', () => {
    /**
     * A second link, on its own universe, sharing the remote. Two links is all
     * the starvation shape needs: one budget that admits exactly one link per
     * tick, and a question about which one.
     */
    async function secondLink(): Promise<string> {
      const { universes, syncLinks, syncRemotes } = await import('../src/db/schema.js');
      await use('A');
      const [u2] = await A.db
        .insert(universes)
        .values({ userId: ownerA.id, name: 'Second World' })
        .returning();
      const [remote] = await A.db.select().from(syncRemotes).where(eq(syncRemotes.userId, ownerA.id));
      const [link] = await A.db
        .insert(syncLinks)
        .values({ universeId: u2.id, remoteId: remote.id })
        .returning();
      return link.id;
    }

    /**
     * A budget that admits exactly ONE link per tick, deterministically: the
     * clock the budget reads jumps 1000ms per call, and the budget is 1500ms.
     * Per tick that is start=T, first link T+1000 (within budget), second link
     * T+2000 (over) — break. Real elapsed time never enters into it, so this
     * cannot flake on a loaded machine.
     */
    function oneLinkPerTick(): Partial<SchedulerOptions> {
      let t = 0;
      return { monotonic: () => (t += 1000), tickBudgetMs: 1500 };
    }

    async function pollAtOf(id: string): Promise<Date | null> {
      const { syncLinks } = await import('../src/db/schema.js');
      const [row] = await A.db.select().from(syncLinks).where(eq(syncLinks.id, id));
      return row.nextPollAt;
    }

    it('reaches on a later tick a link that was past the budget on an earlier one', async () => {
      const otherId = await secondLink();
      // The stagger stamp is the observable here: it is the first thing the
      // loop does to a link it reaches, and it costs no peer traffic at all,
      // so "was this link reached?" is answered without a sync run muddying
      // the budget arithmetic.
      const sched = mk({ ...oneLinkPerTick(), startupStaggerMs: 60_000 });
      const [first, second] = [linkId, otherId].sort();

      await tickN(sched, 1);
      expect(await pollAtOf(first)).not.toBeNull();
      expect(await pollAtOf(second)).toBeNull(); // past the budget, carried over

      // Before this fix, every tick restarted from the top of an UNORDERED
      // result set: the same link was reached again and the tail starved for
      // as long as the budget kept being hit.
      await tickN(sched, 1);
      expect(await pollAtOf(second)).not.toBeNull();
    });
  });

  // ── 12. the first boot after a deploy must not sync the whole fleet ───────

  describe('the first-boot stagger (FIX 4)', () => {
    it('defers a link it has never seen instead of syncing it on the first tick', async () => {
      // 0038 backfills auto_sync = true with last_synced_fingerprint NULL and
      // next_poll_at NULL on every pre-existing link, which is exactly the
      // state of the link this suite builds. Untreated, every such link in a
      // deployment runs a full sync within a tick or two of boot.
      const window = 10 * 60_000;
      const sched = mk({ startupStaggerMs: window });
      await seedEntry('A', 'pre-existing');

      // Pinned jitter, so the slot is an exact instant rather than "somewhere
      // in ten minutes" — the spread itself is staggerDelayMs's own unit test.
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        await tickN(sched, SETTLE_TICKS);
      } finally {
        random.mockRestore();
      }
      expect(runsStarted()).toBe(0);

      // Deferred into the window, and the slot is written down so a process
      // that restarts mid-stagger inherits it rather than re-rolling the herd.
      const held = await linkRow();
      expect(held.nextPollAt).not.toBeNull();
      expect(held.nextPollAt!.getTime()).toBe(clock.getTime() + window / 2);

      // Bounded, not indefinite: once the slot passes, the link syncs normally.
      clock = new Date(clock.getTime() + window + 1);
      await tickN(sched, SETTLE_TICKS);
      expect(runsStarted()).toBe(1);
      expect(await entryTitles('B')).toEqual(['pre-existing']);
    });
  });

  // ── 13. continuous editing ────────────────────────────────────────────────

  it('runs a continuously-edited universe once per ceiling window, not once per tick', async () => {
    const sched = mk();

    // An edit on EVERY tick: stableTicks never reaches STABLE_TICKS_REQUIRED,
    // so MAX_PENDING_TICKS is the only thing that can release a run — the
    // starvation ceiling AS-06 added, exercised end to end.
    for (let i = 0; i < MAX_PENDING_TICKS + 1; i += 1) {
      await seedEntry('A', `burst-${i}`);
      await sched.tick(clock);
    }
    expect(runsStarted()).toBe(1);

    // Editing continues at the same rate. The debounce window must start over
    // FROM THE RUN, so the next release is another whole ceiling away. A window
    // left un-reset stays permanently expired and fires a full sync on every
    // single tick for as long as the user keeps typing.
    for (let i = 0; i < 4; i += 1) {
      await seedEntry('A', `after-${i}`);
      await sched.tick(clock);
    }
    expect(runsStarted()).toBe(1);
  });
});
