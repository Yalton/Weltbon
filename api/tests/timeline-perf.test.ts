import { describe, it, expect } from 'vitest';

describe.skip('Timeline perf (sort-at-scale) — Wave 0 stub (Plan 02 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 02 adds:
  //  - seedLargeUniverse with pinCount=50 → GET /timeline returns sorted < 50ms
  //    median over 5 runs (asserts ASC ordering on doublePrecision position)
});
