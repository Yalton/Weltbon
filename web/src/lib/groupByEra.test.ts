import { describe, it, expect } from 'vitest';

describe.skip('groupByEra (era-grouping pure function) — Wave 0 stub (Plan 04 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 04 adds:
  //  - groupByEra([]) → [{era: null, pins: []}]
  //  - All-era input → each era is its own group with empty pins[]
  //  - All-non-era input → single group with era: null and all pins
  //  - Era then events → {era, pins:[non-era,...]}
  //  - Multiple back-to-back era pins (no events between) → each era distinct group
  //  - Pins before any era → groups[0].era is null
  //  - Sort assumption: input is pre-sorted; function does NOT re-sort
});
