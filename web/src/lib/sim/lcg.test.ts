import { describe, it, expect } from 'vitest';
import { createLcg } from './lcg';

describe('createLcg', () => {
  it('returns a function that produces values in [0, 1)', () => {
    const rng = createLcg(0x57454c54);
    for (let i = 0; i < 20; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is deterministic: same seed produces identical sequences', () => {
    const rng1 = createLcg(0x57454c54);
    const rng2 = createLcg(0x57454c54);
    for (let i = 0; i < 10; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('snapshot: first 5 outputs for seed 0x57454c54 are exactly known values', () => {
    const rng = createLcg(0x57454c54);
    // Precomputed: seed = 0x57454c54 = 1464159316 ("WELT" in ASCII)
    // LCG: seed = (seed * 1664525 + 1013904223) >>> 0
    // val = seed / 0x100000000
    const s0 = 0x57454c54; // 1464159316 — use hex literal to avoid transcription errors
    const s1 = (s0 * 1664525 + 1013904223) >>> 0;
    const s2 = (s1 * 1664525 + 1013904223) >>> 0;
    const s3 = (s2 * 1664525 + 1013904223) >>> 0;
    const s4 = (s3 * 1664525 + 1013904223) >>> 0;
    const s5 = (s4 * 1664525 + 1013904223) >>> 0;
    const expected = [
      s1 / 0x100000000,
      s2 / 0x100000000,
      s3 / 0x100000000,
      s4 / 0x100000000,
      s5 / 0x100000000,
    ];
    const actual = [rng(), rng(), rng(), rng(), rng()];
    expect(actual).toEqual(expected);
  });

  it('different seeds produce different sequences', () => {
    const rng1 = createLcg(1);
    const rng2 = createLcg(2);
    const seq1 = [rng1(), rng1(), rng1()];
    const seq2 = [rng2(), rng2(), rng2()];
    expect(seq1).not.toEqual(seq2);
  });

  it('WELT seed 0x57454c54 is the canonical seed', () => {
    // 0x57454c54 == "WELT" in ASCII
    expect(0x57454c54).toBe(
      ('W'.charCodeAt(0) << 24) |
      ('E'.charCodeAt(0) << 16) |
      ('L'.charCodeAt(0) << 8) |
      ('T'.charCodeAt(0))
    );
  });
});
