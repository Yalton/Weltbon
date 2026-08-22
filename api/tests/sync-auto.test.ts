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
import { createScheduler, type Scheduler } from '../src/services/sync/scheduler.js';
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

  /** The scheduler's clock. Advanced by assignment, never by a real timer. */
  let clock: Date;
  /** 'down' throws at the transport; 'unauthorized' answers 401 to everything. */
  let peerMode: 'up' | 'down' | 'unauthorized';
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
      if (peerMode === 'down') {
        // What an offline peer actually looks like to fetch(): a rejected
        // promise, not a status code.
        throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
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

  function mk(): Scheduler {
    return createScheduler({ now: () => clock, fetchImpl: peerFetch() });
  }

  const runsStarted = () => handshakes;

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
    expect(failed.failureCount).toBeGreaterThanOrEqual(1);
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

  // ── 10. continuous editing ────────────────────────────────────────────────

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
