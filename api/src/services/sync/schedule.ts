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
 * Is there local work this link has not yet pushed?
 *
 * ONE definition, used by both `nextDebounce` and `decide`. It was briefly two
 * — the runtime re-derived it to decide when to rebase the debounce window —
 * and that is a silent-failure shape worth naming: if the copies ever
 * disagreed, coalescing would die in production while every test still passed,
 * because nothing observable distinguishes "the window was rebased on the
 * wrong tick" from "the window was fine" until a user notices their edits
 * syncing on the first keystroke.
 *
 * A null `lastSyncedFingerprint` means never synced, which is unsynced work by
 * definition — not "nothing to do".
 */
export function hasUnsyncedLocalWork(
  link: Pick<LinkSchedulingState, 'lastSyncedFingerprint'>,
  localFingerprint: string,
): boolean {
  return link.lastSyncedFingerprint === null || link.lastSyncedFingerprint !== localFingerprint;
}

/**
 * Advance the debounce window. A fingerprint that keeps moving keeps
 * resetting `stableTicks`, which is precisely how a burst of saves collapses
 * into one run. `pendingTicks` deliberately does NOT reset on a fingerprint
 * change — it tracks how long local work has been waiting, so continuous
 * editing (faster than the stability window) can still be bounded by
 * `MAX_PENDING_TICKS` in `decide` rather than waiting forever.
 *
 * `link` is REQUIRED, and is what makes `pendingTicks` mean what its name
 * says. The counter increments on every call and resets itself never, so on a
 * link with nothing waiting it would otherwise climb past `MAX_PENDING_TICKS`
 * while the universe sits untouched — and the next edit would then satisfy
 * `pendingExpired` on its very first tick, bypassing coalescing entirely for
 * the rest of the process's life. A window measuring work that does not exist
 * measures nothing, so it starts over. Required rather than optional-with-a-
 * default for the same reason `code` and `retry` are required on every
 * SyncRunError (C-19): a call site that has not thought about this must be a
 * compile error, not a silent inheritance of someone else's assumption.
 */
export function nextDebounce(
  previous: DebounceState | undefined,
  localFingerprint: string,
  link: Pick<LinkSchedulingState, 'lastSyncedFingerprint'>,
): DebounceState {
  // Nothing is waiting, so there is no window to carry forward.
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
  // Jitter subtracts from the delay rather than adding to it, so the cap is a
  // real bound. Without it, every client of a recovering prod retries in
  // lockstep and re-creates the outage.
  const spread = raw * 0.2;
  return Math.max(1, Math.round(raw - spread + jitter(spread)));
}

/**
 * How long the FIRST observation of a link defers it, spread uniformly across
 * `windowMs` (#44 whole-branch review, FIX 4).
 *
 * NOT `backoffDelayMs`, and deliberately a separate function rather than a
 * clever reuse of it: backoff answers "this peer just failed, how long before
 * we bother it again?" and grows with the failure count. This answers "the
 * process just started and every link is due at once, which slot does this one
 * get?" — flat, one-shot, and unrelated to whether anything has failed.
 * Collapsing the two would make `failure_count = 0` mean two different things.
 *
 * Uniform over the whole window, with no exponential shape and no floor: the
 * point is that N links landing on this at the same instant end up spread
 * evenly across the window rather than bunched at either end.
 */
export function staggerDelayMs(
  windowMs: number,
  jitter: (n: number) => number = (n) => Math.random() * n,
): number {
  return Math.max(0, Math.round(jitter(Math.max(0, windowMs))));
}

/**
 * Rotate an ORDERED list so it resumes after `cursor` (#44 whole-branch
 * review, FIX 3) — the round-robin half of the tick budget.
 *
 * `rows` MUST already be sorted ascending by the same id `idOf` returns; the
 * scheduler gets that from an ORDER BY, which is the half of this fix that
 * makes "resume after X" a meaningful instruction at all. Against an unordered
 * result set there is no "after".
 *
 * A cursor that is missing, or at/past the end of the set (every id <= it —
 * including a link deleted since the last tick), starts over from the top,
 * which is the same wrap the round-robin performs on every full pass.
 */
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

/**
 * The single scheduling decision for one tick. Order matters: paused/off is
 * checked first because neither is a state the scheduler may reason past,
 * then remote is checked before local stability, then local's own ceiling
 * (`MAX_PENDING_TICKS`) is checked so continuous editing cannot starve a
 * sync indefinitely, and backoff (`nextPollAt`) is checked last, where it
 * gates only the poll branch. That is NOT "backoff never delays local work" —
 * scheduler.ts skips the whole link while a recorded backoff is live, and it
 * has to, because no run reaches local work without a handshake first. See
 * the note at the `run/local` branch below before changing either layer.
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

  const localChanged = hasUnsyncedLocalWork(link, localFingerprint);
  const settled =
    debounce !== undefined &&
    debounce.fingerprint === localFingerprint &&
    debounce.stableTicks >= STABLE_TICKS_REQUIRED;
  // A continuously-changing fingerprint never settles, so this ceiling is
  // what keeps a long active editing session from starving sync entirely.
  const pendingExpired = debounce !== undefined && debounce.pendingTicks >= MAX_PENDING_TICKS;

  // THIS layer does not gate local work on `nextPollAt`, and that is not a
  // claim that a backed-off link should keep running. Backoff is enforced ONE
  // layer up: scheduler.ts skips a link entirely — before it even measures a
  // fingerprint — while a recorded backoff is still live.
  //
  // The runtime is the right place for it because the reason is a fact about
  // runSync, not about scheduling: `drive()` calls `client.handshake()` as its
  // FIRST action, before it builds a manifest, so there is no such thing as a
  // run that pushes local edits without contacting the peer. "Push our own
  // work while the peer is down" is not a behaviour this system can have. What
  // deleting the runtime's gate would actually produce is a full handshake
  // attempt against a dead peer every five seconds, forever, for as long as
  // one unsynced local edit exists — so removing that gate is the bug, not the
  // fix, and this comment is here because its earlier wording said otherwise
  // and read as a rule the runtime was violating.
  if (localChanged && (settled || pendingExpired)) return { kind: 'run', reason: 'local' };

  if (link.nextPollAt === null || link.nextPollAt.getTime() <= now.getTime()) {
    return { kind: 'poll-remote' };
  }

  return { kind: 'idle' };
}
