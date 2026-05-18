import { describe, it, expect } from 'vitest';
import { groupByEra, inferEraSpans, type EraSpan, type TimelinePin } from './groupByEra';

const pin = (overrides: Partial<TimelinePin> = {}): TimelinePin => ({
  id: 'p',
  entryId: 'e',
  label: 'P',
  position: 0,
  precision: 'exact',
  ...overrides,
});

describe('groupByEra', () => {
  it('empty input → single empty group with era=null', () => {
    expect(groupByEra([])).toEqual([{ era: null, pins: [] }]);
  });

  it('all-era input → each era is its own group with pins:[]', () => {
    const eras = [
      pin({ id: 'a', precision: 'era' }),
      pin({ id: 'b', precision: 'era' }),
    ];
    const result = groupByEra(eras);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ era: eras[0], pins: [] });
    expect(result[1]).toEqual({ era: eras[1], pins: [] });
  });

  it('all-non-era input → single group with era=null and all pins', () => {
    const pins = [pin({ id: 'a' }), pin({ id: 'b' })];
    expect(groupByEra(pins)).toEqual([{ era: null, pins }]);
  });

  it('era then events → events grouped under era', () => {
    const era = pin({ id: 'era', precision: 'era' });
    const e1 = pin({ id: 'e1' });
    const e2 = pin({ id: 'e2' });
    const result = groupByEra([era, e1, e2]);
    expect(result).toEqual([{ era, pins: [e1, e2] }]);
  });

  it('multiple back-to-back era pins → each era distinct group with pins:[]', () => {
    const a = pin({ id: 'a', precision: 'era' });
    const b = pin({ id: 'b', precision: 'era' });
    const c = pin({ id: 'c', precision: 'era' });
    const result = groupByEra([a, b, c]);
    expect(result).toEqual([
      { era: a, pins: [] },
      { era: b, pins: [] },
      { era: c, pins: [] },
    ]);
  });

  it('pins before any era → first group has era=null and those pins, subsequent groups carry eras', () => {
    const pre1 = pin({ id: 'pre1' });
    const pre2 = pin({ id: 'pre2' });
    const era = pin({ id: 'era', precision: 'era' });
    const post = pin({ id: 'post' });
    const result = groupByEra([pre1, pre2, era, post]);
    expect(result).toEqual([
      { era: null, pins: [pre1, pre2] },
      { era, pins: [post] },
    ]);
  });

  it('does NOT re-sort the input (caller-pre-sort assumption)', () => {
    const out = pin({ id: 'late', position: 100 });
    const early = pin({ id: 'early', position: 1 });
    const result = groupByEra([out, early]);
    expect(result[0].pins.map((p) => p.id)).toEqual(['late', 'early']);
  });
});

describe('inferEraSpans', () => {
  it('empty input → []', () => {
    expect(inferEraSpans([], 1000)).toEqual<EraSpan[]>([]);
  });

  it('all non-era pins → []', () => {
    const pins = [
      pin({ id: 'a', position: 10 }),
      pin({ id: 'b', position: 20 }),
      pin({ id: 'c', position: 30, precision: 'approximate' }),
    ];
    expect(inferEraSpans(pins, 1000)).toEqual<EraSpan[]>([]);
  });

  it('single era → one span from era.position to windowEnd', () => {
    const era = pin({ id: 'era', position: 100, precision: 'era' });
    const result = inferEraSpans([era], 1000);
    expect(result).toEqual<EraSpan[]>([{ era, startPos: 100, endPos: 1000 }]);
  });

  it('multiple eras → consecutive endPos chain; last runs to windowEnd', () => {
    const a = pin({ id: 'a', position: 100, precision: 'era' });
    const b = pin({ id: 'b', position: 200, precision: 'era' });
    const c = pin({ id: 'c', position: 500, precision: 'era' });
    const result = inferEraSpans([a, b, c], 1000);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ era: a, startPos: 100, endPos: 200 });
    expect(result[1]).toEqual({ era: b, startPos: 200, endPos: 500 });
    expect(result[2]).toEqual({ era: c, startPos: 500, endPos: 1000 });
  });

  it('mixed era + event pins → non-era pins are filtered out', () => {
    const era1 = pin({ id: 'era1', position: 100, precision: 'era' });
    const event = pin({ id: 'event', position: 150 });
    const era2 = pin({ id: 'era2', position: 200, precision: 'era' });
    const result = inferEraSpans([era1, event, era2], 1000);
    expect(result).toEqual<EraSpan[]>([
      { era: era1, startPos: 100, endPos: 200 },
      { era: era2, startPos: 200, endPos: 1000 },
    ]);
  });

  it('back-to-back eras at same position → produces a zero-width span', () => {
    const a = pin({ id: 'a', position: 100, precision: 'era' });
    const b = pin({ id: 'b', position: 100, precision: 'era' });
    const result = inferEraSpans([a, b], 1000);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ era: a, startPos: 100, endPos: 100 });
    expect(result[1]).toEqual({ era: b, startPos: 100, endPos: 1000 });
  });

  it('handles negative-window positions correctly', () => {
    const era = pin({ id: 'era', position: -5000, precision: 'era' });
    const result = inferEraSpans([era], 26000);
    expect(result).toEqual<EraSpan[]>([{ era, startPos: -5000, endPos: 26000 }]);
  });

  it('preserves input ordering (does not re-sort)', () => {
    // Caller is responsible for sorting (same contract as groupByEra).
    // Out-of-order input produces out-of-order output — documented behavior.
    const late = pin({ id: 'late', position: 500, precision: 'era' });
    const early = pin({ id: 'early', position: 100, precision: 'era' });
    const result = inferEraSpans([late, early], 1000);
    expect(result.map((s) => s.era.id)).toEqual(['late', 'early']);
  });
});
