import { describe, it, expect } from 'vitest';
import { posToX, xToPos, clampedPosToX } from './timelineMath';

describe('posToX', () => {
  it('returns 0 at start of window', () => {
    expect(posToX(0, 0, 100, 800)).toBeCloseTo(0, 6);
  });

  it('returns width at end of window', () => {
    expect(posToX(100, 0, 100, 800)).toBeCloseTo(800, 6);
  });

  it('returns width/2 at midpoint of window', () => {
    expect(posToX(50, 0, 100, 800)).toBeCloseTo(400, 6);
  });

  it('handles negative window (start=-10000, end=26000)', () => {
    // pos=-10000 → x=0; pos=26000 → x=800; pos=8000 (midpoint) → x=400
    expect(posToX(-10000, -10000, 26000, 800)).toBeCloseTo(0, 6);
    expect(posToX(26000, -10000, 26000, 800)).toBeCloseTo(800, 6);
    expect(posToX(8000, -10000, 26000, 800)).toBeCloseTo(400, 6);
  });

  it('handles large magnitude (start=0, end=4.35e17)', () => {
    expect(posToX(0, 0, 4.35e17, 800)).toBeCloseTo(0, 6);
    expect(posToX(4.35e17, 0, 4.35e17, 800)).toBeCloseTo(800, 6);
    expect(posToX(2.175e17, 0, 4.35e17, 800)).toBeCloseTo(400, 6);
  });

  it('handles small magnitude (start=0, end=1e-3)', () => {
    expect(posToX(0, 0, 1e-3, 800)).toBeCloseTo(0, 6);
    expect(posToX(1e-3, 0, 1e-3, 800)).toBeCloseTo(800, 6);
    expect(posToX(5e-4, 0, 1e-3, 800)).toBeCloseTo(400, 6);
  });
});

describe('xToPos', () => {
  it('returns start when x=0', () => {
    expect(xToPos(0, 0, 100, 800)).toBeCloseTo(0, 6);
  });

  it('returns end when x=width', () => {
    expect(xToPos(800, 0, 100, 800)).toBeCloseTo(100, 6);
  });

  it('returns midpoint when x=width/2', () => {
    expect(xToPos(400, 0, 100, 800)).toBeCloseTo(50, 6);
  });

  it('clamps x left of the canvas to the window start', () => {
    expect(xToPos(-250, 0, 100, 800)).toBe(0);
  });

  it('clamps x right of the canvas to the window end', () => {
    expect(xToPos(1200, 0, 100, 800)).toBe(100);
  });

  it('clamps against a timeline window with negative positions', () => {
    expect(xToPos(-1, -10000, 26000, 800)).toBe(-10000);
    expect(xToPos(801, -10000, 26000, 800)).toBe(26000);
  });

  it('is the exact inverse of posToX (round-trip) — basic window', () => {
    const start = 0;
    const end = 100;
    const width = 800;
    for (const p of [0, 12.5, 50, 73.7, 100]) {
      expect(xToPos(posToX(p, start, end, width), start, end, width)).toBeCloseTo(p, 6);
    }
  });

  it('is the inverse of posToX over a negative window', () => {
    const start = -10000;
    const end = 26000;
    const width = 800;
    for (const p of [-10000, -5000, 0, 8000, 26000]) {
      expect(xToPos(posToX(p, start, end, width), start, end, width)).toBeCloseTo(p, 6);
    }
  });

  it('is the inverse of posToX over a large-magnitude window', () => {
    const start = 0;
    const end = 4.35e17;
    const width = 800;
    for (const p of [0, 1e15, 2.175e17, 4e17, 4.35e17]) {
      // Large-magnitude values lose relative precision through float math;
      // toBeCloseTo's absolute tolerance is too tight, so check relative error.
      const round = xToPos(posToX(p, start, end, width), start, end, width);
      const denom = Math.max(1, Math.abs(p));
      expect(Math.abs(round - p) / denom).toBeLessThan(1e-10);
    }
  });

  it('is the inverse of posToX over a small-magnitude window', () => {
    const start = 0;
    const end = 1e-3;
    const width = 800;
    for (const p of [0, 1e-9, 5e-4, 1e-3]) {
      expect(xToPos(posToX(p, start, end, width), start, end, width)).toBeCloseTo(p, 12);
    }
  });
});

describe('clampedPosToX', () => {
  it('returns clamped=false for in-range positions', () => {
    expect(clampedPosToX(50, 0, 100, 800)).toEqual({ x: expect.closeTo(400, 6) as unknown as number, clamped: false });
  });

  it('returns { x: 0, clamped: true } for positions below start', () => {
    expect(clampedPosToX(-5, 0, 100, 800)).toEqual({ x: 0, clamped: true });
  });

  it('returns { x: width, clamped: true } for positions above end', () => {
    expect(clampedPosToX(150, 0, 100, 800)).toEqual({ x: 800, clamped: true });
  });

  it('returns clamped=false at exact start boundary (x=0)', () => {
    const r = clampedPosToX(0, 0, 100, 800);
    expect(r.clamped).toBe(false);
    expect(r.x).toBeCloseTo(0, 6);
  });

  it('returns clamped=false at exact end boundary (x=width)', () => {
    const r = clampedPosToX(100, 0, 100, 800);
    expect(r.clamped).toBe(false);
    expect(r.x).toBeCloseTo(800, 6);
  });

  it('handles negative window correctly', () => {
    // start=-10000, end=26000
    expect(clampedPosToX(-20000, -10000, 26000, 800)).toEqual({ x: 0, clamped: true });
    expect(clampedPosToX(30000, -10000, 26000, 800)).toEqual({ x: 800, clamped: true });
    const inside = clampedPosToX(8000, -10000, 26000, 800);
    expect(inside.clamped).toBe(false);
    expect(inside.x).toBeCloseTo(400, 6);
  });

  it('handles large-magnitude positions', () => {
    expect(clampedPosToX(5e17, 0, 4.35e17, 800)).toEqual({ x: 800, clamped: true });
    expect(clampedPosToX(-1, 0, 4.35e17, 800)).toEqual({ x: 0, clamped: true });
  });

  it('handles small-magnitude positions', () => {
    expect(clampedPosToX(2e-3, 0, 1e-3, 800)).toEqual({ x: 800, clamped: true });
    expect(clampedPosToX(-1e-9, 0, 1e-3, 800)).toEqual({ x: 0, clamped: true });
  });
});
