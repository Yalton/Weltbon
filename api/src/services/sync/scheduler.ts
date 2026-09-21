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
const TICK_BUDGET_MS = 30_000;

export interface SchedulerOptions {
  tickMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  tickBudgetMs?: number;
  startupStaggerMs?: number;
  monotonic?: () => number;
  fetchImpl?: FetchLike;
}

function sumCounts(counts: Record<string, number>): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}

export function createScheduler(opts: SchedulerOptions = {}): Scheduler {
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? (() => new Date());

  const tickBudgetMs = opts.tickBudgetMs ?? TICK_BUDGET_MS;
  const staggerMs = opts.startupStaggerMs ?? pollMs;
  const monotonic = opts.monotonic ?? (() => Date.now());

  const debounce = new Map<string, DebounceState>();
  const staggerUntil = new Map<string, Date>();
  const severanceProbed = new Set<string>();
  let cursor: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function tick(at: Date): Promise<void> {
    if (running) return;
    running = true;
    const startedAt = monotonic();

    try {
      // The join supplies each link's owner for authorization in runSync.
      const rows = await db()
        .select({ link: syncLinks, remote: syncRemotes, ownerId: universes.userId })
        .from(syncLinks)
        .innerJoin(syncRemotes, eq(syncLinks.remoteId, syncRemotes.id))
        .innerJoin(universes, eq(syncLinks.universeId, universes.id))
        .where(eq(syncLinks.autoSync, true))
        .orderBy(asc(syncLinks.id));

      const live = new Set(rows.map((r) => r.link.id));
      for (const id of debounce.keys()) {
        if (!live.has(id)) debounce.delete(id);
      }
      for (const id of staggerUntil.keys()) {
        if (!live.has(id)) staggerUntil.delete(id);
      }

      // Rotate the cursor so a budget-limited tick cannot starve later links.
      for (const { link, remote, ownerId } of rotateToCursor(rows, (r) => r.link.id, cursor)) {
        if (monotonic() - startedAt > tickBudgetMs) break; // carry the rest to the next tick
        cursor = link.id;

        if (!link.autoSync || link.pausedReason !== null) {
          debounce.delete(link.id);
          continue;
        }

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
            staggerUntil.set(link.id, at);
          } else if (readyAt.getTime() > at.getTime()) {
            continue;
          }
        }

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
        let failureCount = link.failureCount;

        if (decision.kind === 'poll-remote') {
          try {
            client = remoteClientFor(remote, opts.fetchImpl);
            remoteFingerprint = await client.fingerprint(link.universeId);
          } catch (err) {
            await recordFailure({ id: link.id, failureCount }, err, at);
            continue;
          }
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

          if (remoteFingerprint === null && link.lastSyncedFingerprint !== null) {
            // Force one run per null-fingerprint episode; it may be a deleted remote or older peer.
            if (!severanceProbed.has(link.id)) {
              severanceProbed.add(link.id);
              if (decision.kind !== 'run') decision = { kind: 'run', reason: 'remote' };
            }
          } else if (remoteFingerprint !== null) {
            severanceProbed.delete(link.id);
          }
        }

        if (decision.kind !== 'run') continue;

        try {
          const result = await runSync(link.id, ownerId, { fetchImpl: opts.fetchImpl });

          const settledLocal = await universeFingerprint(link.universeId);

          const appliedLocally =
            sumCounts(result.appliedLocally.upserted) +
            sumCounts(result.appliedLocally.deleted);
          // Keep the pre-run fingerprint when a concurrent local edit was not applied.
          const editedDuringRun = appliedLocally === 0 && settledLocal !== localFingerprint;
          const syncedFingerprint = editedDuringRun ? localFingerprint : settledLocal;
          debounce.set(link.id, { fingerprint: settledLocal, stableTicks: 0, pendingTicks: 0 });

          let settledRemote = remoteFingerprint;
          try {
            client ??= remoteClientFor(remote, opts.fetchImpl);
            settledRemote = (await client.fingerprint(link.universeId)) ?? remoteFingerprint;
          } catch {
            settledRemote = remoteFingerprint;
          }

          if (settledRemote !== null) severanceProbed.delete(link.id);

          await db()
            .update(syncLinks)
            .set({
              lastSyncedFingerprint: syncedFingerprint,
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

  async function recordFailure(
    link: { id: string; failureCount: number },
    err: unknown,
    at: Date,
  ): Promise<void> {
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
