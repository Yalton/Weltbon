
export const STABLE_TICKS_REQUIRED = 2;

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
  pendingTicks: number;
}

export type Decision =
  | { kind: 'idle' }
  | { kind: 'poll-remote' }
  | { kind: 'run'; reason: 'local' | 'remote' };

export function hasUnsyncedLocalWork(
  link: Pick<LinkSchedulingState, 'lastSyncedFingerprint'>,
  localFingerprint: string,
): boolean {
  return link.lastSyncedFingerprint === null || link.lastSyncedFingerprint !== localFingerprint;
}

export function nextDebounce(
  previous: DebounceState | undefined,
  localFingerprint: string,
  link: Pick<LinkSchedulingState, 'lastSyncedFingerprint'>,
): DebounceState {
  const carried = hasUnsyncedLocalWork(link, localFingerprint) ? previous : undefined;

  if (!carried || carried.fingerprint !== localFingerprint) {
    return {
      fingerprint: localFingerprint,
      stableTicks: 0,
      pendingTicks: carried ? carried.pendingTicks + 1 : 0,
    };
  }
  return {
    fingerprint: localFingerprint,
    stableTicks: carried.stableTicks + 1,
    pendingTicks: carried.pendingTicks + 1,
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
  // lockstep and re-creates the outage.
  const spread = raw * 0.2;
  return Math.max(1, Math.round(raw - spread + jitter(spread)));
}

export function staggerDelayMs(
  windowMs: number,
  jitter: (n: number) => number = (n) => Math.random() * n,
): number {
  return Math.max(0, Math.round(jitter(Math.max(0, windowMs))));
}

export function rotateToCursor<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  cursor: string | null,
): T[] {
  if (cursor === null || rows.length === 0) return [...rows];
  const start = rows.findIndex((row) => idOf(row) > cursor);
  if (start <= 0) return [...rows];
  return [...rows.slice(start), ...rows.slice(0, start)];
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
  if (!link.autoSync || link.pausedReason !== null) return { kind: 'idle' };

  // priority over a simultaneously-settled local change — deliberately, not
  if (remoteFingerprint !== null && remoteFingerprint !== link.lastRemoteFingerprint) {
    return { kind: 'run', reason: 'remote' };
  }

  const localChanged = hasUnsyncedLocalWork(link, localFingerprint);
  const settled =
    debounce !== undefined &&
    debounce.fingerprint === localFingerprint &&
    debounce.stableTicks >= STABLE_TICKS_REQUIRED;
  // A continuously-changing fingerprint never settles, so this ceiling is
  const pendingExpired = debounce !== undefined && debounce.pendingTicks >= MAX_PENDING_TICKS;

  // claim that a backed-off link should keep running. Backoff is enforced ONE
  if (localChanged && (settled || pendingExpired)) return { kind: 'run', reason: 'local' };

  if (link.nextPollAt === null || link.nextPollAt.getTime() <= now.getTime()) {
    return { kind: 'poll-remote' };
  }

  return { kind: 'idle' };
}
