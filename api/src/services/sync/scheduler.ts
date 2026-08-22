/**
 * Issue #44 (AS-01, AS-06, AS-07): the auto-sync loop.
 *
 * Deliberately thin. Every RULE lives in schedule.ts as a pure function; this
 * module reads state, asks what to do, and does it. It decides WHEN to call
 * runSync and never reaches inside it.
 *
 * NO DURABLE MEMORY. Everything that must survive a restart is a sync_links
 * column, so a fresh scheduler rebuilds its entire picture from the database on
 * its first tick. The one exception is the debounce window, which is in-memory
 * on purpose: its worst case after a restart is syncing immediately, which is
 * what a user would want anyway.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncLinks, syncRemotes, universes } from '../../db/schema.js';
import { universeFingerprint } from './fingerprint.js';
import { runSync, remoteClientFor } from './run-sync.js';
import { SyncRunError } from './run-errors.js';
import type { FetchLike, SyncRemoteClient } from './remote-client.js';
import {
  decide,
  nextDebounce,
  backoffDelayMs,
  type DebounceState,
  type LinkSchedulingState,
} from './schedule.js';

export interface Scheduler {
  tick(now: Date): Promise<void>;
  start(): void;
  stop(): void;
}

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_POLL_MS = 60_000;
/** Wall-clock a single tick may spend, so one slow link delays rather than starves. */
const TICK_BUDGET_MS = 30_000;

export interface SchedulerOptions {
  tickMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  /**
   * D-05's peer transport, threaded through to runSync and to the fingerprint
   * poll. Production leaves it undefined and gets global fetch; the
   * two-instance test injects a Hono app object, which is the only way this
   * loop can be exercised against a REAL peer rather than a mocked runSync.
   */
  fetchImpl?: FetchLike;
}

export function createScheduler(opts: SchedulerOptions = {}): Scheduler {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? (() => new Date());

  const debounce = new Map<string, DebounceState>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(at: Date): Promise<void> {
    // Re-entrancy guard: a tick that overruns its interval must not overlap
    // itself. Dropping the extra tick is correct — the next one recomputes
    // everything from the database anyway.
    if (running) return;
    running = true;
    // Measured against the REAL clock, not `at`: `at` is injectable and may sit
    // anywhere relative to wall time, and a budget computed from it would
    // either expire instantly or never.
    const startedAt = Date.now();

    try {
      // The universes join is not incidental: runSync(linkId, ownerId) checks
      // ownerId against universes.userId and throws SyncLinkForbiddenError on a
      // mismatch. The HTTP route gets that id from a JWT; the scheduler has no
      // request, so it reads the universe's owner directly.
      const rows = await db()
        .select({ link: syncLinks, remote: syncRemotes, ownerId: universes.userId })
        .from(syncLinks)
        .innerJoin(syncRemotes, eq(syncLinks.remoteId, syncRemotes.id))
        .innerJoin(universes, eq(syncLinks.universeId, universes.id))
        .where(eq(syncLinks.autoSync, true));

      for (const { link, remote, ownerId } of rows) {
        if (Date.now() - startedAt > TICK_BUDGET_MS) break; // carry the rest to the next tick

        // A link with consecutive failures is inside the backoff window
        // recordFailure wrote. decide() consults nextPollAt only on the POLL
        // branch — deliberately, so a backoff can never block a user's own
        // edits from going out to a HEALTHY peer — but a link that is failing
        // has an unhealthy peer, and re-driving a full sync against it on
        // every five-second tick is a retry storm rather than resilience.
        // Skipped before the fingerprint query too: a backed-off link should
        // cost nothing at all, not eighteen aggregates a tick.
        if (
          link.failureCount > 0 &&
          link.nextPollAt !== null &&
          link.nextPollAt.getTime() > at.getTime()
        ) {
          continue;
        }

        const localFingerprint = await universeFingerprint(link.universeId);

        // `pendingTicks` (schedule.ts) counts ticks that local work has been
        // WAITING to sync, and nextDebounce cannot see the link row, so it
        // increments on every tick including ones where nothing is waiting at
        // all. Handing it a fresh window whenever this link has nothing
        // unsynced is what keeps an idle link from climbing past
        // MAX_PENDING_TICKS — otherwise the first edit after a quiet stretch
        // bypasses coalescing entirely and syncs on the opening keystroke of
        // every burst. The condition is the negation of decide()'s own
        // `localChanged`; it is checked here because DebounceState has no
        // self-reset and the pure module has nothing to reset it from.
        const hasUnsyncedLocalWork =
          link.lastSyncedFingerprint === null || link.lastSyncedFingerprint !== localFingerprint;
        const nextWindow = nextDebounce(
          hasUnsyncedLocalWork ? debounce.get(link.id) : undefined,
          localFingerprint,
        );
        debounce.set(link.id, nextWindow);

        const state: LinkSchedulingState = {
          linkId: link.id,
          autoSync: link.autoSync,
          pausedReason: link.pausedReason,
          lastSyncedFingerprint: link.lastSyncedFingerprint,
          lastRemoteFingerprint: link.lastRemoteFingerprint,
          nextPollAt: link.nextPollAt,
          failureCount: link.failureCount,
        };

        let decision = decide({
          link: state,
          localFingerprint,
          debounce: nextWindow,
          remoteFingerprint: null,
          now: at,
        });

        let client: SyncRemoteClient | null = null;
        let remoteFingerprint: string | null = null;
        // What recordFailure must count from. A successful poll below resets
        // it, so a failure later in this same tick starts a fresh streak
        // rather than continuing one the peer just disproved.
        let failureCount = link.failureCount;

        if (decision.kind === 'poll-remote') {
          try {
            client = remoteClientFor(remote, opts.fetchImpl);
            remoteFingerprint = await client.fingerprint(link.universeId);
          } catch (err) {
            await recordFailure({ id: link.id, failureCount }, err, at);
            continue;
          }
          // failure_count is reset by ANY success, and answering a probe is a
          // success: the peer is demonstrably reachable again. Without this the
          // link stays inside the backoff skip above until its NEXT poll window,
          // so the local edits that are already settled and waiting would sit
          // there for a further poll interval after the peer came back.
          failureCount = 0;
          await db()
            .update(syncLinks)
            .set({ nextPollAt: new Date(at.getTime() + pollMs), failureCount: 0 })
            .where(eq(syncLinks.id, link.id));

          decision = decide({
            link: state,
            localFingerprint,
            debounce: nextWindow,
            remoteFingerprint,
            now: at,
          });
        }

        if (decision.kind !== 'run') continue;

        try {
          await runSync(link.id, ownerId, { fetchImpl: opts.fetchImpl });

          // AS-05: capture the local fingerprint AFTER the run. A sync that
          // applied remote ops has just changed local state, so a value read
          // before the run would look like pending local edits and re-trigger
          // this link forever.
          const settledLocal = await universeFingerprint(link.universeId);
          // BOTH counters, not just stableTicks. pendingTicks accumulates
          // across fingerprint changes by design and nothing else ever clears
          // it, so a window left half-reset here makes MAX_PENDING_TICKS
          // permanently expired and every later edit skip its debounce.
          debounce.set(link.id, { fingerprint: settledLocal, stableTicks: 0, pendingTicks: 0 });

          // The peer has just changed BECAUSE OF US. Re-probe so
          // lastRemoteFingerprint describes the POST-run peer; recording the
          // pre-run value instead would make the very next poll read our own
          // push as "a remote change" and start a redundant run after every
          // single sync. Best-effort: the run already succeeded, so a probe
          // that fails must not turn it into a failure — the stale value only
          // costs that one redundant run.
          let settledRemote = remoteFingerprint;
          try {
            client ??= remoteClientFor(remote, opts.fetchImpl);
            settledRemote = (await client.fingerprint(link.universeId)) ?? remoteFingerprint;
          } catch {
            settledRemote = remoteFingerprint;
          }

          await db()
            .update(syncLinks)
            .set({
              lastSyncedFingerprint: settledLocal,
              // Only overwrite what we actually observed.
              ...(settledRemote !== null ? { lastRemoteFingerprint: settledRemote } : {}),
              failureCount: 0,
              pausedReason: null,
              nextPollAt: new Date(at.getTime() + pollMs),
            })
            .where(eq(syncLinks.id, link.id));
        } catch (err) {
          await recordFailure({ id: link.id, failureCount }, err, at);
        }
      }
    } finally {
      running = false;
    }
  }

  /**
   * One place decides what a failure MEANS, so a poll failure and a run failure
   * cannot drift apart. The policy comes off the error class (AS-08), never
   * from an instanceof chain here.
   *
   * Note what this does NOT do: it never clears lastSyncedFingerprint and never
   * touches the base snapshot. A failed run leaves the link exactly where it
   * was, and the next successful run picks up from there — that is runSync's
   * own idempotence guarantee, and duplicating any of it here would re-implement
   * what sync already does.
   */
  async function recordFailure(
    link: { id: string; failureCount: number },
    err: unknown,
    at: Date,
  ): Promise<void> {
    // Not a SyncRunError means OUR bug, not the peer's problem. Treat it as
    // transient: a coding error must never permanently pause a healthy link,
    // which is a state only a human can clear.
    const policy = err instanceof SyncRunError ? err.retry : 'retry';

    if (policy === 'skip') return; // contention: no counter, no backoff, nothing shown

    if (policy === 'stop') {
      await db()
        .update(syncLinks)
        .set({ pausedReason: err instanceof SyncRunError ? err.code : 'internal' })
        .where(eq(syncLinks.id, link.id));
      return;
    }

    const count = link.failureCount + 1;
    await db()
      .update(syncLinks)
      .set({ failureCount: count, nextPollAt: new Date(at.getTime() + backoffDelayMs(count)) })
      .where(eq(syncLinks.id, link.id));
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick(now()).catch((err) => {
          // A tick must never reject into an unhandled rejection: everything
          // per-link is already caught, so anything reaching here is the link
          // QUERY itself failing (a database blip). Log and wait for the next
          // tick — there is nothing else a scheduler can usefully do.
          console.warn('[auto-sync] tick failed:', err);
        });
      }, tickMs);
      timer.unref?.(); // never hold the process open on this alone
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
