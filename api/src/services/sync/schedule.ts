/**
 * Issue #44 (AS-06, AS-08): every scheduling RULE, as pure functions.
 *
 * Nothing here touches a database, a socket, or the wall clock — `now` arrives
 * as an argument. That is deliberate: the rules worth testing (debounce,
 * backoff, what "due" means) are exactly the rules that are miserable to test
 * through a real timer, and keeping them here leaves scheduler.ts with nothing
 * but wiring.
 */

/** Consecutive ticks a local fingerprint must hold still before we sync. */
export const STABLE_TICKS_REQUIRED = 2;

/**
 * Ceiling on how long local work may be coalesced before it runs anyway,
 * counted in ticks (roughly two minutes at the default 5-second tick).
 *
 * `stableTicks` resets on every fingerprint change, which is the whole point
 * of coalescing a burst into one run — but a link that is edited faster than
 * two tick-intervals apart (the web editor's own draft autosave can do this
 * during a long active session) would otherwise NEVER accumulate two stable
 * ticks, and `decide` would never return `run/local`. Without this ceiling a
 * continuously-edited universe simply never syncs, which a multi-device user
 * experiences as the feature being broken, not as "still coalescing."
 *
 * Running mid-edit is safe: sync applies whole rows last-write-wins, it is
 * the user's own content going out, and the next tick's run corrects
 * whatever the snapshot missed.
 */
export const MAX_PENDING_TICKS = 24;

const DEFAULT_BASE_MS = 60_000;
const DEFAULT_CAP_MS = 30 * 60 * 1000;

export interface LinkSchedulingState {
  linkId: string;
  autoSync: boolean;
  pausedReason: string | null;
  lastSyncedFingerprint: string | null;
  lastRemoteFingerprint: string | null;
  nextPollAt: Date | null;
  failureCount: number;
}

export interface DebounceState {
  fingerprint: string;
  stableTicks: number;
  /**
   * Ticks since local work first started waiting to sync. Unlike
   * `stableTicks`, a fingerprint change never resets this — it accumulates
   * ACROSS changes, which is what lets `decide` bound worst-case staleness
   * during continuous editing (see `MAX_PENDING_TICKS`).
   */
  pendingTicks: number;
}

export type Decision =
  | { kind: 'idle' }
  | { kind: 'poll-remote' }
  | { kind: 'run'; reason: 'local' | 'remote' };

/**
 * Advance the debounce window. A fingerprint that keeps moving keeps
 * resetting `stableTicks`, which is precisely how a burst of saves collapses
 * into one run. `pendingTicks` deliberately does NOT reset on a fingerprint
 * change — it tracks how long local work has been waiting, so continuous
 * editing (faster than the stability window) can still be bounded by
 * `MAX_PENDING_TICKS` in `decide` rather than waiting forever.
 */
export function nextDebounce(
  previous: DebounceState | undefined,
  localFingerprint: string,
): DebounceState {
  if (!previous || previous.fingerprint !== localFingerprint) {
    return {
      fingerprint: localFingerprint,
      stableTicks: 0,
      pendingTicks: previous ? previous.pendingTicks + 1 : 0,
    };
  }
  return {
    fingerprint: localFingerprint,
    stableTicks: previous.stableTicks + 1,
    pendingTicks: previous.pendingTicks + 1,
  };
}

export function backoffDelayMs(
  failureCount: number,
  opts: { baseMs?: number; capMs?: number; jitter?: (n: number) => number } = {},
): number {
  const base = opts.baseMs ?? DEFAULT_BASE_MS;
  const cap = opts.capMs ?? DEFAULT_CAP_MS;
  const jitter = opts.jitter ?? ((n: number) => Math.random() * n);

  const n = Math.max(1, failureCount);
  const raw = Math.min(cap, base * 2 ** (n - 1));
  // Jitter subtracts from the delay rather than adding to it, so the cap is a
  // real bound. Without it, every client of a recovering prod retries in
  // lockstep and re-creates the outage.
  const spread = raw * 0.2;
  return Math.max(1, Math.round(raw - spread + jitter(spread)));
}

/**
 * The single scheduling decision for one tick. Order matters: paused/off is
 * checked first because neither is a state the scheduler may reason past,
 * then remote is checked before local stability, then local's own ceiling
 * (`MAX_PENDING_TICKS`) is checked so continuous editing cannot starve a
 * sync indefinitely, and backoff (`nextPollAt`) is checked last and only
 * gates polling, never local work.
 */
export function decide(input: {
  link: LinkSchedulingState;
  localFingerprint: string;
  debounce: DebounceState | undefined;
  remoteFingerprint: string | null;
  now: Date;
}): Decision {
  const { link, localFingerprint, debounce, remoteFingerprint, now } = input;

  // A paused link is stopped until a human acts (AS-08). Auto-sync off is the
  // user's explicit choice. Neither is a state the scheduler may reason past.
  if (!link.autoSync || link.pausedReason !== null) return { kind: 'idle' };

  // Remote first: a peer change is already old news by the time we see it, and
  // there is no burst of ours to wait out. This also means remote wins
  // priority over a simultaneously-settled local change — deliberately, not
  // by accident of ordering.
  if (remoteFingerprint !== null && remoteFingerprint !== link.lastRemoteFingerprint) {
    return { kind: 'run', reason: 'remote' };
  }

  const localChanged =
    link.lastSyncedFingerprint === null || localFingerprint !== link.lastSyncedFingerprint;
  const settled =
    debounce !== undefined &&
    debounce.fingerprint === localFingerprint &&
    debounce.stableTicks >= STABLE_TICKS_REQUIRED;
  // A continuously-changing fingerprint never settles, so this ceiling is
  // what keeps a long active editing session from starving sync entirely.
  const pendingExpired = debounce !== undefined && debounce.pendingTicks >= MAX_PENDING_TICKS;

  // Local work runs even while polling is backed off: backoff is about an
  // unhealthy PEER, and a link that stopped pushing our own edits would look
  // broken for a reason the user cannot see.
  if (localChanged && (settled || pendingExpired)) return { kind: 'run', reason: 'local' };

  if (link.nextPollAt === null || link.nextPollAt.getTime() <= now.getTime()) {
    return { kind: 'poll-remote' };
  }

  return { kind: 'idle' };
}
