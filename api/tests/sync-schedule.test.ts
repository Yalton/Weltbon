import { describe, it, expect } from 'vitest';
import {
  decide, nextDebounce, hasUnsyncedLocalWork, backoffDelayMs,
  rotateToCursor, staggerDelayMs,
  STABLE_TICKS_REQUIRED, MAX_PENDING_TICKS,
  type LinkSchedulingState, type DebounceState, type Decision,
} from '../src/services/sync/schedule.js';

const NOW = new Date('2026-08-22T12:00:00Z');

const link = (over: Partial<LinkSchedulingState> = {}): LinkSchedulingState => ({
  linkId: 'L1',
  autoSync: true,
  pausedReason: null,
  lastSyncedFingerprint: 'FP0',
  lastRemoteFingerprint: 'RP0',
  nextPollAt: null,
  failureCount: 0,
  ...over,
});

describe('nextDebounce', () => {
  it('starts a fresh window when the fingerprint first changes', () => {
    expect(nextDebounce(undefined, 'FP1', link())).toEqual({ fingerprint: 'FP1', stableTicks: 0, pendingTicks: 0 });
  });

  it('counts consecutive ticks where the fingerprint held still', () => {
    const a = nextDebounce(undefined, 'FP1', link());
    const b = nextDebounce(a, 'FP1', link());
    expect(b.stableTicks).toBe(1);
    expect(nextDebounce(b, 'FP1', link()).stableTicks).toBe(2);
  });

  it('resets the count when the fingerprint moves again — this is the coalescing', () => {
    const a = nextDebounce(nextDebounce(undefined, 'FP1', link()), 'FP1', link());
    expect(a.stableTicks).toBe(1);
    const moved = nextDebounce(a, 'FP2', link());
    expect(moved).toEqual({ fingerprint: 'FP2', stableTicks: 0, pendingTicks: 2 });
  });

  it('accumulates pendingTicks across fingerprint changes — unlike stableTicks, a change never resets it', () => {
    let d: DebounceState | undefined = undefined;
    d = nextDebounce(d, 'FP1', link());
    d = nextDebounce(d, 'FP2', link()); // changed
    d = nextDebounce(d, 'FP2', link()); // held
    d = nextDebounce(d, 'FP3', link()); // changed again
    // 3 ticks have elapsed since work first started waiting (the first call
    // establishes tick 0), regardless of how many times the fingerprint
    // itself moved in between.
    expect(d.pendingTicks).toBe(3);
    // stableTicks, by contrast, was reset by the last change.
    expect(d.stableTicks).toBe(0);
  });

  it('does not accumulate pendingTicks on an IDLE link, however long it idles', () => {
    // The counter never resets itself, so if a link with nothing waiting were
    // still allowed to advance it, an untouched universe would cross
    // MAX_PENDING_TICKS purely by the scheduler ticking — and the user's NEXT
    // edit would then satisfy `pendingExpired` on its first tick and sync on
    // the opening keystroke, with coalescing dead for the life of the process.
    // Idling for four times the ceiling is well past where that would show.
    const idle = link({ lastSyncedFingerprint: 'FP-settled' });
    let d: DebounceState | undefined = undefined;
    for (let i = 0; i < MAX_PENDING_TICKS * 4; i++) {
      d = nextDebounce(d, 'FP-settled', idle);
    }
    expect(d!.pendingTicks).toBe(0);

    // And the proof that it matters: one real edit now, and the very first
    // tick must still be "settling", not "the ceiling already expired".
    const afterEdit = nextDebounce(d, 'FP-edited', idle);
    // One tick of waiting, counted from the edit — not the thousands of ticks
    // the process happened to have been up for.
    expect(afterEdit.pendingTicks).toBe(1);
    expect(afterEdit.pendingTicks).toBeLessThan(MAX_PENDING_TICKS);
    expect(
      decide({
        link: idle, localFingerprint: 'FP-edited',
        debounce: afterEdit, remoteFingerprint: null, now: NOW,
      }).kind,
    ).not.toBe('run');
  });

  it('rebases a window carried over from work that has since synced', () => {
    // The same rule from the other direction: a window built while work was
    // pending must not survive into the state where that work is synced.
    const pending = link({ lastSyncedFingerprint: 'FP-old' });
    let d = nextDebounce(undefined, 'FP-new', pending);
    d = nextDebounce(d, 'FP-new', pending);
    expect(d.pendingTicks).toBe(1);

    const synced = link({ lastSyncedFingerprint: 'FP-new' });
    expect(nextDebounce(d, 'FP-new', synced)).toEqual({
      fingerprint: 'FP-new', stableTicks: 0, pendingTicks: 0,
    });
  });
});

describe('hasUnsyncedLocalWork', () => {
  it('is true when the link has never synced', () => {
    expect(hasUnsyncedLocalWork({ lastSyncedFingerprint: null }, 'FP1')).toBe(true);
  });

  it('is true when the local fingerprint has moved past what was synced', () => {
    expect(hasUnsyncedLocalWork({ lastSyncedFingerprint: 'FP1' }, 'FP2')).toBe(true);
  });

  it('is false when local matches what was last synced', () => {
    expect(hasUnsyncedLocalWork({ lastSyncedFingerprint: 'FP1' }, 'FP1')).toBe(false);
  });

  it('is the SAME predicate decide() uses for localChanged', () => {
    // One definition, two consumers. If these ever diverged, the debounce
    // window would be rebased on ticks decide() considers to have pending
    // work — coalescing would break in production with every test still green,
    // which is exactly why the predicate is not written out twice.
    for (const [lastSynced, fp] of [[null, 'FP1'], ['FP1', 'FP2'], ['FP1', 'FP1']] as const) {
      const l = link({ lastSyncedFingerprint: lastSynced, nextPollAt: new Date(NOW.getTime() + 60_000) });
      const settledWindow: DebounceState = {
        fingerprint: fp, stableTicks: STABLE_TICKS_REQUIRED, pendingTicks: STABLE_TICKS_REQUIRED,
      };
      const wouldRun =
        decide({ link: l, localFingerprint: fp, debounce: settledWindow, remoteFingerprint: null, now: NOW })
          .kind === 'run';
      expect(wouldRun).toBe(hasUnsyncedLocalWork(l, fp));
    }
  });
});

describe('decide', () => {
  it('does nothing when auto-sync is off', () => {
    const d = decide({
      link: link({ autoSync: false }), localFingerprint: 'FP9',
      debounce: { fingerprint: 'FP9', stableTicks: 9, pendingTicks: 9 }, remoteFingerprint: 'RP9', now: NOW,
    });
    expect(d.kind).toBe('idle');
  });

  it('does nothing when the link is paused, however much has changed', () => {
    const d = decide({
      link: link({ pausedReason: 'remote-unauthorized' }), localFingerprint: 'FP9',
      debounce: { fingerprint: 'FP9', stableTicks: 9, pendingTicks: 9 }, remoteFingerprint: 'RP9', now: NOW,
    });
    expect(d.kind).toBe('idle');
  });

  it('holds off while local edits are still arriving', () => {
    const d = decide({
      link: link(), localFingerprint: 'FP1',
      debounce: { fingerprint: 'FP1', stableTicks: STABLE_TICKS_REQUIRED - 1, pendingTicks: STABLE_TICKS_REQUIRED - 1 },
      remoteFingerprint: 'RP0', now: NOW,
    });
    expect(d.kind).not.toBe('run');
  });

  it('runs once local edits have held still', () => {
    const d = decide({
      link: link(), localFingerprint: 'FP1',
      debounce: { fingerprint: 'FP1', stableTicks: STABLE_TICKS_REQUIRED, pendingTicks: STABLE_TICKS_REQUIRED },
      remoteFingerprint: 'RP0', now: NOW,
    });
    expect(d).toEqual({ kind: 'run', reason: 'local' });
  });

  it('runs immediately on a remote change, without waiting for stability', () => {
    // We cannot observe the peer's burst, so there is nothing to wait for.
    const d = decide({
      link: link(), localFingerprint: 'FP0', debounce: undefined,
      remoteFingerprint: 'RP1', now: NOW,
    });
    expect(d).toEqual({ kind: 'run', reason: 'remote' });
  });

  it('prefers a remote run over a simultaneously-settled local change — this pins priority, not coincidence', () => {
    // Both conditions qualify here: local has changed AND is settled, remote
    // has also changed. A refactor that swapped the branch order would still
    // pass every other test in this file but would flip this result to
    // { kind: 'run', reason: 'local' } — that is exactly what this pins down.
    const d = decide({
      link: link(), localFingerprint: 'FP1',
      debounce: { fingerprint: 'FP1', stableTicks: STABLE_TICKS_REQUIRED, pendingTicks: STABLE_TICKS_REQUIRED },
      remoteFingerprint: 'RP1', now: NOW,
    });
    expect(d).toEqual({ kind: 'run', reason: 'remote' });
  });

  it('asks for a remote poll when one is due and nothing else is pending', () => {
    const d = decide({
      link: link({ nextPollAt: new Date(NOW.getTime() - 1) }),
      localFingerprint: 'FP0', debounce: undefined, remoteFingerprint: null, now: NOW,
    });
    expect(d.kind).toBe('poll-remote');
  });

  it('does not poll before the poll is due — this is how backoff is enforced', () => {
    const d = decide({
      link: link({ nextPollAt: new Date(NOW.getTime() + 60_000) }),
      localFingerprint: 'FP0', debounce: undefined, remoteFingerprint: null, now: NOW,
    });
    expect(d.kind).toBe('idle');
  });

  it('still runs a local change while backed off from polling', () => {
    // Backoff is about reaching an unhealthy PEER. Local edits are ours, and a
    // link that stopped pushing local work would look broken to the user.
    const d = decide({
      link: link({ nextPollAt: new Date(NOW.getTime() + 60_000), failureCount: 3 }),
      localFingerprint: 'FP1',
      debounce: { fingerprint: 'FP1', stableTicks: STABLE_TICKS_REQUIRED, pendingTicks: STABLE_TICKS_REQUIRED },
      remoteFingerprint: null, now: NOW,
    });
    expect(d).toEqual({ kind: 'run', reason: 'local' });
  });

  it('does not run local work before the pending ceiling, even though the fingerprint keeps changing every tick', () => {
    // A continuously-moving fingerprint never settles (stableTicks stays 0),
    // so without the ceiling this would wait forever.
    const d = decide({
      link: link(), localFingerprint: 'FP-current',
      debounce: { fingerprint: 'FP-current', stableTicks: 0, pendingTicks: MAX_PENDING_TICKS - 1 },
      remoteFingerprint: null, now: NOW,
    });
    expect(d.kind).not.toBe('run');
  });

  it('runs local work once pendingTicks reaches the ceiling, even with a fingerprint that never settles', () => {
    // This is the starvation fix: a long active editing session (fingerprint
    // changing faster than the stability window) still syncs eventually.
    const d = decide({
      link: link(), localFingerprint: 'FP-current',
      debounce: { fingerprint: 'FP-current', stableTicks: 0, pendingTicks: MAX_PENDING_TICKS },
      remoteFingerprint: null, now: NOW,
    });
    expect(d).toEqual({ kind: 'run', reason: 'local' });
  });

  it('still coalesces a short burst into a single run rather than firing per edit', () => {
    let debounce: DebounceState | undefined = undefined;
    let d: Decision = { kind: 'idle' };

    // A short burst of distinct edits, well under the pending ceiling.
    for (const fp of ['FP1', 'FP2', 'FP3']) {
      debounce = nextDebounce(debounce, fp, link());
      d = decide({ link: link(), localFingerprint: fp, debounce, remoteFingerprint: null, now: NOW });
      expect(d.kind).not.toBe('run');
    }

    // Editing stops; the last fingerprint has to hold still for
    // STABLE_TICKS_REQUIRED ticks before anything runs.
    const finalFp = 'FP3';
    for (let i = 0; i < STABLE_TICKS_REQUIRED - 1; i++) {
      debounce = nextDebounce(debounce, finalFp, link());
      d = decide({ link: link(), localFingerprint: finalFp, debounce, remoteFingerprint: null, now: NOW });
      expect(d.kind).not.toBe('run');
    }

    debounce = nextDebounce(debounce, finalFp, link());
    d = decide({ link: link(), localFingerprint: finalFp, debounce, remoteFingerprint: null, now: NOW });
    expect(d).toEqual({ kind: 'run', reason: 'local' });
  });
});

describe('backoffDelayMs', () => {
  const noJitter = { jitter: (n: number) => n };

  it('grows with consecutive failures', () => {
    const a = backoffDelayMs(1, noJitter);
    const b = backoffDelayMs(2, noJitter);
    const c = backoffDelayMs(3, noJitter);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('is bounded — the INTERVAL is capped, the attempts are not', () => {
    // A laptop closed for a weekend must resume on reconnect, so there is no
    // attempt limit; what is bounded is how long the wait can grow.
    expect(backoffDelayMs(50, noJitter)).toBe(backoffDelayMs(60, noJitter));
    expect(backoffDelayMs(50, noJitter)).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it('applies jitter within the delay, never beyond it', () => {
    // The jitter callback receives the SPREAD, not the whole delay. Returning
    // a value scaled off the full delay would push the result past the cap —
    // which is why this asserts the bound rather than trusting the callback.
    const plain = backoffDelayMs(4, noJitter);
    const jittered = backoffDelayMs(4, { jitter: (n) => n / 2 });
    expect(jittered).toBeGreaterThan(0);
    expect(jittered).toBeLessThanOrEqual(plain);
  });

  it('returns the base delay for the first failure', () => {
    expect(backoffDelayMs(1, { ...noJitter, baseMs: 1000 })).toBe(1000);
  });
});

describe('rotateToCursor (FIX 3 — the tick budget must not always cut the same prefix)', () => {
  const rows = ['a', 'b', 'c', 'd'];
  const id = (r: string) => r;

  it('starts from the top when there is no cursor', () => {
    expect(rotateToCursor(rows, id, null)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('resumes AFTER the cursor', () => {
    expect(rotateToCursor(rows, id, 'b')).toEqual(['c', 'd', 'a', 'b']);
  });

  it('wraps to the top once the cursor reaches the end', () => {
    expect(rotateToCursor(rows, id, 'd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('resumes after a cursor whose link no longer exists', () => {
    // The link the last tick stopped on can be deleted before the next one.
    // "After b" is still a well-defined place in an ORDERED set even when b
    // itself is gone — which is the whole reason the query has an ORDER BY.
    expect(rotateToCursor(['a', 'c', 'd'], id, 'b')).toEqual(['c', 'd', 'a']);
  });

  it('never drops or duplicates a row, wherever the cursor sits', () => {
    for (const cursor of [null, 'a', 'b', 'c', 'd', 'z']) {
      expect([...rotateToCursor(rows, id, cursor)].sort()).toEqual(rows);
    }
  });

  it('handles an empty set', () => {
    expect(rotateToCursor([], id, 'a')).toEqual([]);
  });
});

describe('staggerDelayMs (FIX 4 — the first boot after a deploy)', () => {
  it('spreads uniformly across the window, unlike the exponential backoff', () => {
    expect(staggerDelayMs(60_000, () => 0)).toBe(0);
    expect(staggerDelayMs(60_000, (n) => n / 2)).toBe(30_000);
    expect(staggerDelayMs(60_000, (n) => n)).toBe(60_000);
  });

  it('never exceeds the window and is never negative', () => {
    for (let i = 0; i < 200; i += 1) {
      const d = staggerDelayMs(60_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });

  it('is zero for a zero window, so the stagger can be switched off', () => {
    expect(staggerDelayMs(0)).toBe(0);
  });

  it('is NOT backoffDelayMs: it does not grow, and knows nothing of failures', () => {
    // Conflating the two would make failure_count mean two different things.
    // Same jitter, same window, same answer every time.
    const flat = [1, 2, 3, 4].map(() => staggerDelayMs(60_000, (n) => n / 4));
    expect(flat).toEqual([15_000, 15_000, 15_000, 15_000]);
    const growing = [1, 2, 3, 4].map((n) => backoffDelayMs(n, { jitter: () => 0, baseMs: 60_000 }));
    expect(new Set(growing).size).toBeGreaterThan(1);
  });
});
