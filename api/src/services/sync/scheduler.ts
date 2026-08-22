/**
 * Issue #44 (AS-01, AS-06, AS-07): the auto-sync loop.
 *
 * Deliberately thin. Every RULE lives in schedule.ts as a pure function; this
 * module reads state, asks what to do, and does it. It decides WHEN to call
 * runSync and never reaches inside it.
 *
 * NO DURABLE MEMORY. Everything that must survive a restart is a sync_links
 * column, so a fresh scheduler rebuilds its entire picture from the database on
 * its first tick. Three things are in-memory on purpose, and each is a
 * statement about THIS PROCESS rather than about the link: the debounce window
 * (worst case after a restart is syncing immediately, which is what a user
 * would want anyway), the first-boot stagger (which exists precisely because
 * the process just started), and the round-robin cursor (worst case is one
 * tick that starts from the top of the list).
 */
import { asc, eq } from 'drizzle-orm';
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
  rotateToCursor,
  staggerDelayMs,
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
/**
 * Wall-clock a single tick may spend, so one slow link delays rather than
 * starves. Checked only BETWEEN links — runSync is not interruptible — which
 * is why the budget alone is not enough and the round-robin cursor below moves
 * the cut point every tick.
 */
const TICK_BUDGET_MS = 30_000;

export interface SchedulerOptions {
  tickMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  /** See TICK_BUDGET_MS. */
  tickBudgetMs?: number;
  /**
   * How wide the first-observation stagger window is (FIX 4). Production wants
   * the default (one poll interval); a test that is not about the stagger
   * passes 0 to switch it off, so its first tick acts immediately.
   */
  startupStaggerMs?: number;
  /**
   * Elapsed-time source for the tick BUDGET only — never for scheduling, which
   * uses `now`/`at`. Separate from `now` on purpose: the budget must measure
   * real elapsed work (see the note in tick()), so it cannot ride on the
   * injectable, freely-positioned scheduling clock. Injectable all the same,
   * per AS-11, because "what happens to the links past the budget" is only
   * testable if a test can make the budget expire on demand.
   */
  monotonic?: () => number;
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

  const tickBudgetMs = opts.tickBudgetMs ?? TICK_BUDGET_MS;
  const staggerMs = opts.startupStaggerMs ?? pollMs;
  const monotonic = opts.monotonic ?? (() => Date.now());

  const debounce = new Map<string, DebounceState>();
  /**
   * FIX 4's first-observation hold, keyed by link id.
   *
   * ABSENT means "this process has never seen this link". PRESENT means it
   * has, and the value is the instant the link is free to be scheduled — the
   * jittered slot for a link that was staggered, or simply the moment it was
   * first seen for one that owed no stagger. In-memory like `debounce`, and
   * for the same reason: it describes this process's startup, not the link.
   */
  const staggerUntil = new Map<string, Date>();
  /**
   * Round-robin position (FIX 3): the id of the last link the previous tick
   * REACHED. The next tick resumes after it, so the point where the budget
   * cuts the list moves every tick instead of pinning the same prefix.
   * In-memory: losing it on a restart costs one tick that starts from the top.
   */
  let cursor: string | null = null;
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
    const startedAt = monotonic();

    try {
      // The universes join is not incidental: runSync(linkId, ownerId) checks
      // ownerId against universes.userId and throws SyncLinkForbiddenError on a
      // mismatch. The HTTP route gets that id from a JWT; the scheduler has no
      // request, so it reads the universe's owner directly.
      //
      // ORDER BY is load-bearing, not tidiness (#44 whole-branch review, FIX
      // 3). This loop stops at the tick budget, so an unordered result set
      // means the set of links that get served is whatever the planner
      // happened to return first — and since every tick restarted from the
      // top of that set, links in the tail could starve indefinitely once the
      // budget was routinely hit. A stable order is what makes "resume where
      // the last tick stopped" below expressible at all.
      const rows = await db()
        .select({ link: syncLinks, remote: syncRemotes, ownerId: universes.userId })
        .from(syncLinks)
        .innerJoin(syncRemotes, eq(syncLinks.remoteId, syncRemotes.id))
        .innerJoin(universes, eq(syncLinks.universeId, universes.id))
        .where(eq(syncLinks.autoSync, true))
        .orderBy(asc(syncLinks.id));

      // FIX 5: the debounce Map is keyed by link id and nothing else ever
      // removes from it, so a deleted link (or one whose auto-sync was turned
      // off) would keep its entry for the life of the process. Prune against
      // the rows actually in play before touching any of them. staggerUntil is
      // keyed and pruned identically, for the identical reason.
      const live = new Set(rows.map((r) => r.link.id));
      for (const id of debounce.keys()) {
        if (!live.has(id)) debounce.delete(id);
      }
      for (const id of staggerUntil.keys()) {
        if (!live.has(id)) staggerUntil.delete(id);
      }

      // The other half of FIX 3: start after the link the last tick reached,
      // wrapping at the end. Without this the budget always cuts the SAME
      // prefix and one user's slow link can keep every other tenant's link
      // from ever being reached. runSync is not preemptible, so a single slow
      // run still blocks the tick it is in — this bounds the DAMAGE (nobody
      // starves forever) rather than eliminating the delay.
      for (const { link, remote, ownerId } of rotateToCursor(rows, (r) => r.link.id, cursor)) {
        if (monotonic() - startedAt > tickBudgetMs) break; // carry the rest to the next tick
        // Set for every link this tick REACHES, including ones it skips: a
        // link that has been looked at this tick is behind us either way, and
        // the next tick should move on rather than re-examine it first.
        cursor = link.id;

        // A paused link cannot produce any decision but 'idle' (decide()
        // checks pausedReason first and never reasons past it), so measuring
        // its fingerprint is eighteen aggregate queries per tick, forever, for
        // an answer that cannot change. decide() is still the authority on the
        // decision — this only declines to do expensive work to reach a
        // foregone one. Its window goes too: a link that cannot run has no
        // work waiting, and a human unpausing it should get a fresh
        // coalescing window rather than one aged during the pause.
        //
        // autoSync is already excluded by the query's WHERE, and is re-checked
        // here only so this short-circuit matches decide()'s own guard exactly
        // rather than depending on the query staying that way.
        if (!link.autoSync || link.pausedReason !== null) {
          debounce.delete(link.id);
          continue;
        }

        // FIX 4 (#44 whole-branch review) — the first-boot stagger.
        //
        // Migration 0038 backfills auto_sync = true on EVERY pre-existing
        // link, with last_synced_fingerprint NULL (so all local work reads as
        // pending) and next_poll_at NULL (so a poll is immediately due).
        // Untreated, roughly ten seconds after a new version boots every
        // pre-existing link in the deployment builds a full manifest and
        // handshakes its peer, simultaneously. Give a link this process has
        // never seen before a jittered slot somewhere in the next poll
        // interval, and leave it alone until that slot arrives.
        //
        // WHY THE IN-MEMORY HOLD AND NOT next_poll_at ALONE: decide() consults
        // nextPollAt only on the POLL branch — deliberately, so a wait can
        // never block a user's own edits (see schedule.ts) — and a backfilled
        // link takes the run/local branch, because its lastSyncedFingerprint
        // is NULL. Stamping the column without holding the link would defer
        // the fleet by exactly one tick and then stampede on the next. The
        // column is still written, so a process that restarts mid-stagger
        // inherits the slot instead of re-rolling the whole herd.
        //
        // BOUNDED, and it cannot strand a genuinely new link: at most one
        // window, at most once per link per process, and "Sync now" is
        // unaffected the entire time.
        if (staggerMs > 0) {
          const readyAt = staggerUntil.get(link.id);
          if (readyAt === undefined) {
            if (link.nextPollAt === null) {
              const until = new Date(at.getTime() + staggerDelayMs(staggerMs));
              staggerUntil.set(link.id, until);
              await db()
                .update(syncLinks)
                .set({ nextPollAt: until })
                .where(eq(syncLinks.id, link.id));
              continue;
            }
            // Already scheduled by some earlier tick or earlier process, so
            // there is no herd to spread here. Record it as seen, owing
            // nothing, and never consider it again.
            staggerUntil.set(link.id, at);
          } else if (readyAt.getTime() > at.getTime()) {
            continue;
          }
        }

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

        const state: LinkSchedulingState = {
          linkId: link.id,
          autoSync: link.autoSync,
          pausedReason: link.pausedReason,
          lastSyncedFingerprint: link.lastSyncedFingerprint,
          lastRemoteFingerprint: link.lastRemoteFingerprint,
          nextPollAt: link.nextPollAt,
          failureCount: link.failureCount,
        };

        // The link row goes IN because whether the window has anything to
        // measure is a scheduling rule, and every scheduling rule lives in
        // schedule.ts. This used to be a `hasUnsyncedLocalWork ? previous :
        // undefined` ternary right here, which quietly made the runtime a
        // second home for decide()'s `localChanged` predicate — two copies
        // that had to agree forever, whose disagreement kills coalescing in
        // production without failing a single test.
        const nextWindow = nextDebounce(debounce.get(link.id), localFingerprint, state);
        debounce.set(link.id, nextWindow);

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
          //
          // KNOWN WINDOW, PARKED DELIBERATELY (#44 review round 1). An edit
          // that lands DURING the run — after drive() called
          // buildSyncManifest, before the run returns — was never in the
          // manifest that went to the peer, yet it IS in this fingerprint. So
          // it is recorded as synced when it was not, and it reaches the peer
          // only when some later run happens to rebuild a manifest. The
          // post-run remote re-probe below has the mirror of this window.
          //
          // Capturing after the run is still the RIGHT choice: capturing
          // before it is not a smaller bug but a much larger one — a run that
          // applied remote ops would leave lastSyncedFingerprint permanently
          // behind local state, decide() would return run/local on every tick
          // from then on, and the link would sync in a loop forever against an
          // untouched universe. Losing an edit until the next run beats that
          // by a wide margin.
          //
          // It is also bounded rather than permanent: ANY later run in EITHER
          // direction rebuilds a fresh manifest and carries the stranded edit
          // with it, so only a link that never syncs again strands it — and
          // such a link is one nobody is editing either.
          //
          // The durable fix is for runSync to RETURN the local (and remote)
          // fingerprints it actually observed at manifest-build time, so this
          // records what was really sent instead of what is here now. That
          // changes runSync's contract, which this plan's "never reach inside
          // runSync" constraint puts out of scope. Do not paper over it here
          // with a pre-run capture; see above for why that is worse.
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

          // failureCount and pausedReason are DELIBERATELY absent from this
          // SET (#44 whole-branch review, FIX 1): releaseLink now clears both
          // — plus nextPollAt — inside runSync, on every successful run, so
          // the manual route gets the identical clear instead of only this
          // one. Re-adding them here would recreate the second, divergent
          // copy that fix removed. This UPDATE runs after runSync has
          // returned, so its nextPollAt is simply the later of two sequential
          // writes, and the scheduler keeps sole ownership of the fingerprints
          // and of when the NEXT poll is due.
          await db()
            .update(syncLinks)
            .set({
              lastSyncedFingerprint: settledLocal,
              // Only overwrite what we actually observed.
              ...(settledRemote !== null ? { lastRemoteFingerprint: settledRemote } : {}),
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
