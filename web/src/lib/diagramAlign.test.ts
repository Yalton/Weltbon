/**
 * diagramAlign.test.ts — unit coverage for snap rounding, each align edge,
 * equal-spacing distribute, and degenerate inputs.
 *
 * Covers:
 *   - snapToGrid: rounding to nearest grid multiple, gridSize <= 0 passthrough
 *   - alignNodes: 6 align edges (left/right/top/bottom/center-x/center-y)
 *   - distributeNodes: equal spacing for >=3 nodes, no-op for <3
 *   - degenerate inputs: single node, empty selection
 */
import { describe, it, expect } from 'vitest';
import { snapToGrid, alignNodes, distributeNodes } from './diagramAlign';

// ─── Shared fixture type ───────────────────────────────────────────────────────

interface TestNode {
  id: string;
  x: number;
  y: number;
}

// ─── snapToGrid ───────────────────────────────────────────────────────────────

describe('snapToGrid', () => {
  it('rounds x and y to the nearest multiple of gridSize', () => {
    const result = snapToGrid({ x: 23, y: 9 }, 16);
    expect(result.x).toBe(16);
    expect(result.y).toBe(16);
  });

  it('snaps up when closer to the next multiple', () => {
    // 25 is closer to 32 than to 16 (distance 7 vs 9)
    const result = snapToGrid({ x: 25, y: 25 }, 16);
    expect(result.x).toBe(32);
    expect(result.y).toBe(32);
  });

  it('returns integer multiples (x=0, y=0 for small values on large grid)', () => {
    const result = snapToGrid({ x: 5, y: 6 }, 16);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('returns the point unchanged when gridSize is 0', () => {
    const p = { x: 23, y: 9 };
    const result = snapToGrid(p, 0);
    expect(result.x).toBe(23);
    expect(result.y).toBe(9);
  });

  it('returns the point unchanged when gridSize is negative', () => {
    const p = { x: 23, y: 9 };
    const result = snapToGrid(p, -4);
    expect(result.x).toBe(23);
    expect(result.y).toBe(9);
  });

  it('handles a point already on the grid', () => {
    const result = snapToGrid({ x: 32, y: 48 }, 16);
    expect(result.x).toBe(32);
    expect(result.y).toBe(48);
  });

  it('handles gridSize of 1 (all integers snap to themselves)', () => {
    const result = snapToGrid({ x: 7, y: 13 }, 1);
    expect(result.x).toBe(7);
    expect(result.y).toBe(13);
  });
});

// ─── alignNodes ──────────────────────────────────────────────────────────────

describe('alignNodes — left', () => {
  const nodes: TestNode[] = [
    { id: 'A', x: 100, y: 50 },
    { id: 'B', x: 200, y: 80 },
    { id: 'C', x: 150, y: 120 },
  ];

  it('sets every node x to the minimum x in the selection', () => {
    const result = alignNodes(nodes, 'left');
    expect(result.get('A')?.x).toBe(100);
    expect(result.get('B')?.x).toBe(100);
    expect(result.get('C')?.x).toBe(100);
  });

  it('preserves y coordinates', () => {
    const result = alignNodes(nodes, 'left');
    expect(result.get('A')?.y).toBe(50);
    expect(result.get('B')?.y).toBe(80);
    expect(result.get('C')?.y).toBe(120);
  });

  it('returns every input node', () => {
    const result = alignNodes(nodes, 'left');
    expect(result.size).toBe(3);
  });
});

describe('alignNodes — right', () => {
  const nodes: TestNode[] = [
    { id: 'A', x: 100, y: 50 },
    { id: 'B', x: 200, y: 80 },
    { id: 'C', x: 150, y: 120 },
  ];

  it('sets every node x to the maximum x in the selection', () => {
    const result = alignNodes(nodes, 'right');
    expect(result.get('A')?.x).toBe(200);
    expect(result.get('B')?.x).toBe(200);
    expect(result.get('C')?.x).toBe(200);
  });
});

describe('alignNodes — top', () => {
  const nodes: TestNode[] = [
    { id: 'A', x: 100, y: 50 },
    { id: 'B', x: 200, y: 80 },
    { id: 'C', x: 150, y: 120 },
  ];

  it('sets every node y to the minimum y in the selection', () => {
    const result = alignNodes(nodes, 'top');
    expect(result.get('A')?.y).toBe(50);
    expect(result.get('B')?.y).toBe(50);
    expect(result.get('C')?.y).toBe(50);
  });

  it('preserves x coordinates', () => {
    const result = alignNodes(nodes, 'top');
    expect(result.get('A')?.x).toBe(100);
    expect(result.get('B')?.x).toBe(200);
    expect(result.get('C')?.x).toBe(150);
  });
});

describe('alignNodes — bottom', () => {
  const nodes: TestNode[] = [
    { id: 'A', x: 100, y: 50 },
    { id: 'B', x: 200, y: 80 },
    { id: 'C', x: 150, y: 120 },
  ];

  it('sets every node y to the maximum y in the selection', () => {
    const result = alignNodes(nodes, 'bottom');
    expect(result.get('A')?.y).toBe(120);
    expect(result.get('B')?.y).toBe(120);
    expect(result.get('C')?.y).toBe(120);
  });
});

describe('alignNodes — center-x', () => {
  const nodes: TestNode[] = [
    { id: 'A', x: 100, y: 50 },
    { id: 'B', x: 200, y: 80 },
    { id: 'C', x: 150, y: 120 },
  ];

  it('sets every node x to the mean x of the selection', () => {
    // mean x = (100 + 200 + 150) / 3 = 150
    const result = alignNodes(nodes, 'center-x');
    expect(result.get('A')?.x).toBeCloseTo(150, 5);
    expect(result.get('B')?.x).toBeCloseTo(150, 5);
    expect(result.get('C')?.x).toBeCloseTo(150, 5);
  });
});

describe('alignNodes — center-y', () => {
  const nodes: TestNode[] = [
    { id: 'A', x: 100, y: 50 },
    { id: 'B', x: 200, y: 80 },
    { id: 'C', x: 150, y: 120 },
  ];

  it('sets every node y to the mean y of the selection', () => {
    // mean y = (50 + 80 + 120) / 3 ≈ 83.33
    const mean = (50 + 80 + 120) / 3;
    const result = alignNodes(nodes, 'center-y');
    expect(result.get('A')?.y).toBeCloseTo(mean, 5);
    expect(result.get('B')?.y).toBeCloseTo(mean, 5);
    expect(result.get('C')?.y).toBeCloseTo(mean, 5);
  });
});

describe('alignNodes — degenerate inputs', () => {
  it('returns a single node unchanged', () => {
    const nodes: TestNode[] = [{ id: 'A', x: 100, y: 50 }];
    const result = alignNodes(nodes, 'left');
    expect(result.get('A')).toEqual({ x: 100, y: 50 });
    expect(result.size).toBe(1);
  });

  it('returns empty map for empty selection', () => {
    const result = alignNodes([], 'left');
    expect(result.size).toBe(0);
  });
});

// ─── distributeNodes ─────────────────────────────────────────────────────────

describe('distributeNodes — horizontal', () => {
  it('yields equal x-gaps between consecutive nodes (sorted by x), endpoints fixed', () => {
    const nodes: TestNode[] = [
      { id: 'A', x: 0, y: 50 },
      { id: 'B', x: 100, y: 80 }, // middle — may shift
      { id: 'C', x: 200, y: 120 },
    ];

    const result = distributeNodes(nodes, 'horizontal');

    // Endpoints must be fixed
    expect(result.get('A')?.x).toBe(0);
    expect(result.get('C')?.x).toBe(200);

    // Middle node should be equidistant from A and C → x = 100
    expect(result.get('B')?.x).toBeCloseTo(100, 5);

    // Consecutive gaps must be equal
    const sorted = ['A', 'B', 'C'].map((id) => result.get(id)!.x).sort((a, b) => a - b);
    const gap1 = sorted[1] - sorted[0];
    const gap2 = sorted[2] - sorted[1];
    expect(gap1).toBeCloseTo(gap2, 5);
  });

  it('distributes unequally-spaced nodes to equal gaps', () => {
    const nodes: TestNode[] = [
      { id: 'A', x: 0, y: 0 },
      { id: 'B', x: 30, y: 0 },  // close to left
      { id: 'C', x: 120, y: 0 },
    ];

    const result = distributeNodes(nodes, 'horizontal');

    // Endpoints A=0, C=120 are fixed; B should move to 60
    expect(result.get('A')?.x).toBe(0);
    expect(result.get('C')?.x).toBe(120);
    expect(result.get('B')?.x).toBeCloseTo(60, 5);
  });

  it('preserves y coordinates', () => {
    const nodes: TestNode[] = [
      { id: 'A', x: 0, y: 10 },
      { id: 'B', x: 50, y: 20 },
      { id: 'C', x: 100, y: 30 },
    ];

    const result = distributeNodes(nodes, 'horizontal');
    expect(result.get('A')?.y).toBe(10);
    expect(result.get('B')?.y).toBe(20);
    expect(result.get('C')?.y).toBe(30);
  });
});

describe('distributeNodes — vertical', () => {
  it('yields equal y-gaps between consecutive nodes (sorted by y), endpoints fixed', () => {
    const nodes: TestNode[] = [
      { id: 'A', x: 50, y: 0 },
      { id: 'B', x: 80, y: 30 }, // close to top
      { id: 'C', x: 120, y: 200 },
    ];

    const result = distributeNodes(nodes, 'vertical');

    // Endpoints must be fixed
    expect(result.get('A')?.y).toBe(0);
    expect(result.get('C')?.y).toBe(200);

    // Middle node B should be at 100 (equidistant)
    expect(result.get('B')?.y).toBeCloseTo(100, 5);

    // Consecutive gaps must be equal
    const sorted = ['A', 'B', 'C'].map((id) => result.get(id)!.y).sort((a, b) => a - b);
    const gap1 = sorted[1] - sorted[0];
    const gap2 = sorted[2] - sorted[1];
    expect(gap1).toBeCloseTo(gap2, 5);
  });

  it('preserves x coordinates', () => {
    const nodes: TestNode[] = [
      { id: 'A', x: 10, y: 0 },
      { id: 'B', x: 20, y: 50 },
      { id: 'C', x: 30, y: 100 },
    ];

    const result = distributeNodes(nodes, 'vertical');
    expect(result.get('A')?.x).toBe(10);
    expect(result.get('B')?.x).toBe(20);
    expect(result.get('C')?.x).toBe(30);
  });
});

describe('distributeNodes — degenerate inputs', () => {
  it('returns input positions unchanged for fewer than 3 nodes (2 nodes)', () => {
    const nodes: TestNode[] = [
      { id: 'A', x: 0, y: 0 },
      { id: 'B', x: 100, y: 50 },
    ];
    const result = distributeNodes(nodes, 'horizontal');
    expect(result.get('A')).toEqual({ x: 0, y: 0 });
    expect(result.get('B')).toEqual({ x: 100, y: 50 });
  });

  it('returns input positions unchanged for a single node', () => {
    const nodes: TestNode[] = [{ id: 'A', x: 42, y: 7 }];
    const result = distributeNodes(nodes, 'horizontal');
    expect(result.get('A')).toEqual({ x: 42, y: 7 });
  });

  it('returns empty map for empty input', () => {
    const result = distributeNodes([], 'horizontal');
    expect(result.size).toBe(0);
  });

  it('does not throw for fewer than 3 nodes', () => {
    expect(() => distributeNodes([{ id: 'A', x: 0, y: 0 }], 'vertical')).not.toThrow();
    expect(() => distributeNodes([], 'vertical')).not.toThrow();
  });
});

describe('distributeNodes — 4+ nodes', () => {
  it('yields equal gaps across 4 nodes horizontally', () => {
    const nodes: TestNode[] = [
      { id: 'A', x: 0, y: 0 },
      { id: 'B', x: 10, y: 0 },  // non-uniform original spacing
      { id: 'C', x: 50, y: 0 },
      { id: 'D', x: 90, y: 0 },
    ];
    const result = distributeNodes(nodes, 'horizontal');

    // Endpoints fixed
    expect(result.get('A')?.x).toBe(0);
    expect(result.get('D')?.x).toBe(90);

    // B and C should be at 30 and 60
    expect(result.get('B')?.x).toBeCloseTo(30, 5);
    expect(result.get('C')?.x).toBeCloseTo(60, 5);
  });
});
