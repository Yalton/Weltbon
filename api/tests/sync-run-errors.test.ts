import { describe, it, expect } from 'vitest';
import * as errors from '../src/services/sync/run-errors.js';
import { SyncRunError } from '../src/services/sync/run-errors.js';

/**
 * Enumerates the module rather than listing classes by hand: a new
 * SyncRunError subclass added later is covered the moment it is exported,
 * which is the entire point of declaring the policy on the class.
 */
function everySubclass(): Array<new (...args: never[]) => SyncRunError> {
  // `as unknown[]` because the module also exports non-class values now
  // (TOKEN_FIXABLE_PAUSE_REASONS). The runtime filter below already excludes
  // them via `typeof v === 'function'`; this only stops the type predicate
  // being checked against a union it was never meant to narrow.
  return (Object.values(errors) as unknown[]).filter(
    (v): v is new (...args: never[]) => SyncRunError =>
      typeof v === 'function' &&
      v !== SyncRunError &&
      v.prototype instanceof SyncRunError,
  );
}

describe('SyncRunError retry policy', () => {
  it('every subclass is exported and declares a policy', () => {
    const subclasses = everySubclass();
    expect(subclasses.length).toBeGreaterThanOrEqual(17);
    for (const Cls of subclasses) {
      const instance = Object.create(Cls.prototype) as SyncRunError;
      expect(['skip', 'retry', 'stop'], Cls.name).toContain(instance.retry);
    }
  });

  it('contention is a skip, never a failure', () => {
    // Counting a busy lease as failure would make a healthy busy system look
    // broken and would back it off for no reason.
    expect(Object.create(errors.SyncBusyError.prototype).retry).toBe('skip');
  });

  it('an unreachable peer retries', () => {
    expect(Object.create(errors.SyncUnreachableError.prototype).retry).toBe('retry');
  });

  it('rejected credentials stop', () => {
    expect(Object.create(errors.SyncAuthError.prototype).retry).toBe('stop');
  });

  it('a lapsed subscription stops', () => {
    expect(Object.create(errors.SyncPaymentError.prototype).retry).toBe('stop');
  });

  it('an incompatible peer stops — a retry cannot upgrade anything', () => {
    expect(Object.create(errors.SyncIncompatibleError.prototype).retry).toBe('stop');
  });

  it('a refused apply stops — replaying it earns the same refusal', () => {
    expect(Object.create(errors.SyncApplyRejectedError.prototype).retry).toBe('stop');
  });

  it('blob-unavailable retries only when the PEER is the one missing bytes', () => {
    const proto = errors.SyncBlobUnavailableError.prototype;
    const withSide = (side: string) => Object.assign(Object.create(proto), { side });
    expect(withSide('remote').retry).toBe('retry');
    expect(withSide('local').retry).toBe('stop');
    expect(withSide('neither').retry).toBe('stop');
  });
});
