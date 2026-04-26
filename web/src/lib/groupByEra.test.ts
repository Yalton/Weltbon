import { describe, it, expect } from 'vitest';
import { groupByEra, type TimelinePin } from './groupByEra';

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
