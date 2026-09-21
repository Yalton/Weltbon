import { describe, it, expect } from 'vitest';
import { patchSchema } from '../src/routes/universes.js';

describe('universes patchSchema — timelineWindow', () => {
  it('accepts a finite { start, end } object', () => {
    const result = patchSchema.parse({ timelineWindow: { start: -10000, end: 26000 } });
    expect(result.timelineWindow).toEqual({ start: -10000, end: 26000 });
  });

  it('accepts null (clear window)', () => {
    const result = patchSchema.parse({ timelineWindow: null });
    expect(result.timelineWindow).toBeNull();
  });

  it('rejects non-finite start (Infinity → T-20-01)', () => {
    expect(() =>
      patchSchema.parse({ timelineWindow: { start: Infinity, end: 1 } }),
    ).toThrow();
  });

  it('rejects non-finite end (NaN → T-20-01)', () => {
    expect(() =>
      patchSchema.parse({ timelineWindow: { start: 0, end: Number.NaN } }),
    ).toThrow();
  });

  it('rejects a body with no recognized fields', () => {
    // refine() still fires when timelineWindow / name / description are all undefined.
    expect(() => patchSchema.parse({})).toThrow();
  });

  it('treats timelineWindow alone as a non-empty body (passes refine)', () => {
    // Confirms the refine() update includes timelineWindow !== undefined.
    expect(() =>
      patchSchema.parse({ timelineWindow: { start: 0, end: 1 } }),
    ).not.toThrow();
  });
});
