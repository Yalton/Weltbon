import { describe, expect, it } from 'vitest';
import { createFixedWindowLimiter } from '../src/services/rate-limit.js';

describe('createFixedWindowLimiter', () => {
  function limiterAt(start = 1_000_000) {
    let now = start;
    const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    return { limiter, advance: (ms: number) => { now += ms; } };
  }

  it('allows up to the limit within one window, then refuses', () => {
    const { limiter } = limiterAt();
    expect([1, 2, 3].map(() => limiter.hit('a').allowed)).toEqual([true, true, true]);
    const refused = limiter.hit('a');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);
  });

  it('counts each key separately', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 3; i++) limiter.hit('a');
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
  });

  it('starts a fresh window once the old one has elapsed', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 3; i++) limiter.hit('a');
    advance(59_999);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    advance(1);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('reset() forgets every key', () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < 3; i++) limiter.hit('a');
    limiter.reset();
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('drops expired windows so the map does not grow without bound', () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < 50; i++) limiter.hit(`ip-${i}`);
    expect(limiter.size()).toBe(50);
    advance(60_000);
    limiter.hit('fresh');
    expect(limiter.size()).toBe(1);
  });

  it('refuses new keys once maxKeys live windows are tracked, but keeps serving known keys', () => {
    let now = 1_000_000;
    const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 60_000, maxKeys: 10, now: () => now });
    for (let i = 0; i < 10; i++) expect(limiter.hit(`ip-${i}`).allowed).toBe(true);

    const overflow = limiter.hit('ip-new');
    expect(overflow.allowed).toBe(false);
    expect(overflow.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.size()).toBe(10);
    expect(limiter.hit('ip-0').allowed).toBe(true);

    now += 60_000;
    expect(limiter.hit('ip-new').allowed).toBe(true);
  });

  it('check() reports an exhausted window without counting a hit', () => {
    const { limiter, advance } = limiterAt();
    expect(limiter.check('a')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.size()).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect(limiter.check('a').allowed).toBe(true);
      limiter.hit('a');
    }
    advance(15_000);
    expect(limiter.check('a')).toEqual({ allowed: false, retryAfterSeconds: 45 });
    expect(limiter.check('b').allowed).toBe(true);
    advance(45_000);
    expect(limiter.check('a').allowed).toBe(true);
  });
});
