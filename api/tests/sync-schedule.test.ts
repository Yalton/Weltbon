import { describe, it, expect } from 'vitest';
import {
  decide, nextDebounce, backoffDelayMs, STABLE_TICKS_REQUIRED, MAX_PENDING_TICKS,
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
    expect(nextDebounce(undefined, 'FP1')).toEqual({ fingerprint: 'FP1', stableTicks: 0, pendingTicks: 0 });
  });

  it('counts consecutive ticks where the fingerprint held still', () => {
    const a = nextDebounce(undefined, 'FP1');
    const b = nextDebounce(a, 'FP1');
    expect(b.stableTicks).toBe(1);
    expect(nextDebounce(b, 'FP1').stableTicks).toBe(2);
  });

  it('resets the count when the fingerprint moves again — this is the coalescing', () => {
    const a = nextDebounce(nextDebounce(undefined, 'FP1'), 'FP1');
    expect(a.stableTicks).toBe(1);
    const moved = nextDebounce(a, 'FP2');
    expect(moved).toEqual({ fingerprint: 'FP2', stableTicks: 0, pendingTicks: 2 });
  });

  it('accumulates pendingTicks across fingerprint changes — unlike stableTicks, a change never resets it', () => {
    let d: DebounceState | undefined = undefined;
    d = nextDebounce(d, 'FP1');
    d = nextDebounce(d, 'FP2'); // changed
    d = nextDebounce(d, 'FP2'); // held
    d = nextDebounce(d, 'FP3'); // changed again
    // 3 ticks have elapsed since work first started waiting (the first call
    // establishes tick 0), regardless of how many times the fingerprint
    // itself moved in between.
    expect(d.pendingTicks).toBe(3);
    // stableTicks, by contrast, was reset by the last change.
    expect(d.stableTicks).toBe(0);
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
      debounce = nextDebounce(debounce, fp);
      d = decide({ link: link(), localFingerprint: fp, debounce, remoteFingerprint: null, now: NOW });
      expect(d.kind).not.toBe('run');
    }

    // Editing stops; the last fingerprint has to hold still for
    // STABLE_TICKS_REQUIRED ticks before anything runs.
    const finalFp = 'FP3';
    for (let i = 0; i < STABLE_TICKS_REQUIRED - 1; i++) {
      debounce = nextDebounce(debounce, finalFp);
      d = decide({ link: link(), localFingerprint: finalFp, debounce, remoteFingerprint: null, now: NOW });
      expect(d.kind).not.toBe('run');
    }

    debounce = nextDebounce(debounce, finalFp);
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
