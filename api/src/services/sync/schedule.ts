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
}

export type Decision =
  | { kind: 'idle' }
  | { kind: 'poll-remote' }
  | { kind: 'run'; reason: 'local' | 'remote' };

/**
 * Advance the debounce window. A fingerprint that keeps moving keeps resetting
 * the count, which is precisely how a burst of saves collapses into one run.
 */
export function nextDebounce(
  previous: DebounceState | undefined,
  localFingerprint: string,
): DebounceState {
  if (!previous || previous.fingerprint !== localFingerprint) {
    return { fingerprint: localFingerprint, stableTicks: 0 };
  }
  return { fingerprint: localFingerprint, stableTicks: previous.stableTicks + 1 };
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
  // there is no burst of ours to wait out.
  if (remoteFingerprint !== null && remoteFingerprint !== link.lastRemoteFingerprint) {
    return { kind: 'run', reason: 'remote' };
  }

  const localChanged =
    link.lastSyncedFingerprint === null || localFingerprint !== link.lastSyncedFingerprint;
  const settled =
    debounce !== undefined &&
    debounce.fingerprint === localFingerprint &&
    debounce.stableTicks >= STABLE_TICKS_REQUIRED;

  // Local work runs even while polling is backed off: backoff is about an
  // unhealthy PEER, and a link that stopped pushing our own edits would look
  // broken for a reason the user cannot see.
  if (localChanged && settled) return { kind: 'run', reason: 'local' };

  if (link.nextPollAt === null || link.nextPollAt.getTime() <= now.getTime()) {
    return { kind: 'poll-remote' };
  }

  return { kind: 'idle' };
}
