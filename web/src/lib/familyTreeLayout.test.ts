import { describe, it, expect } from 'vitest';
import { familyTreeLayout, PARENT_TERMS, isParentEdge } from './familyTreeLayout';

// ─── Shared fixture types ─────────────────────────────────────────────────────

interface TestNode {
  id: string;
  x: number;
  y: number;
}

interface TestEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
}

// ─── PARENT_TERMS ─────────────────────────────────────────────────────────────

describe('PARENT_TERMS', () => {
  it('contains exactly 10 terms from the UI-SPEC', () => {
    const expected = [
      'parent', 'child', 'mother', 'father', 'son', 'daughter', 'sibling',
      'step-parent', 'step-mother', 'step-father',
    ];
    expect(PARENT_TERMS).toHaveLength(10);
    for (const term of expected) {
      expect(PARENT_TERMS).toContain(term);
    }
  });
});

// ─── isParentEdge ─────────────────────────────────────────────────────────────

describe('isParentEdge', () => {
  it('returns true for exact lowercase parent terms', () => {
    expect(isParentEdge({ id: 'e1', source: 'a', target: 'b', label: 'parent' })).toBe(true);
    expect(isParentEdge({ id: 'e2', source: 'a', target: 'b', label: 'mother' })).toBe(true);
    expect(isParentEdge({ id: 'e3', source: 'a', target: 'b', label: 'child' })).toBe(true);
    expect(isParentEdge({ id: 'e4', source: 'a', target: 'b', label: 'step-parent' })).toBe(true);
  });

  it('returns true for case-insensitive label match ("Father" matches "father")', () => {
    expect(isParentEdge({ id: 'e5', source: 'a', target: 'b', label: 'Father' })).toBe(true);
    expect(isParentEdge({ id: 'e6', source: 'a', target: 'b', label: 'MOTHER' })).toBe(true);
    expect(isParentEdge({ id: 'e7', source: 'a', target: 'b', label: 'Step-Parent' })).toBe(true);
  });

  it('returns false for null label', () => {
    expect(isParentEdge({ id: 'e8', source: 'a', target: 'b', label: null })).toBe(false);
  });

  it('returns false for empty string label', () => {
    expect(isParentEdge({ id: 'e9', source: 'a', target: 'b', label: '' })).toBe(false);
  });

  it('returns false for non-parent labels', () => {
    expect(isParentEdge({ id: 'e10', source: 'a', target: 'b', label: 'rival' })).toBe(false);
    expect(isParentEdge({ id: 'e11', source: 'a', target: 'b', label: 'twice-married' })).toBe(false);
    expect(isParentEdge({ id: 'e12', source: 'a', target: 'b', label: 'ally' })).toBe(false);
  });
});

// ─── familyTreeLayout — simple tree ─────────────────────────────────────────

describe('familyTreeLayout — simple parent->two-children tree', () => {
  /**
   * Tree:
   *   Parent (A)
   *   /        \
   * Child1(B)  Child2(C)
   *
   * Edges:
   *   A --parent--> B  (A is the parent of B)
   *   A --parent--> C  (A is the parent of C)
   *
   * Convention: edge label "parent" means source is the parent of target.
   * So A has no incoming parent edges → A is a root node.
   */
  const nodes: TestNode[] = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 0, y: 0 },
    { id: 'C', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'A', target: 'B', label: 'parent' },
    { id: 'e2', source: 'A', target: 'C', label: 'parent' },
  ];

  it('returns a position for every node id', () => {
    const result = familyTreeLayout(nodes, edges);
    expect(result.get('A')).toBeDefined();
    expect(result.get('B')).toBeDefined();
    expect(result.get('C')).toBeDefined();
  });

  it('places children below the parent (parent.y < child.y)', () => {
    const result = familyTreeLayout(nodes, edges);
    const parent = result.get('A')!;
    const child1 = result.get('B')!;
    const child2 = result.get('C')!;
    expect(parent.y).toBeLessThan(child1.y);
    expect(parent.y).toBeLessThan(child2.y);
  });

  it('places children on the same row (same y)', () => {
    const result = familyTreeLayout(nodes, edges);
    const child1 = result.get('B')!;
    const child2 = result.get('C')!;
    expect(child1.y).toBe(child2.y);
  });

  it('places the parent horizontally centered above children', () => {
    const result = familyTreeLayout(nodes, edges);
    const parent = result.get('A')!;
    const child1 = result.get('B')!;
    const child2 = result.get('C')!;
    const midX = (child1.x + child2.x) / 2;
    expect(parent.x).toBeCloseTo(midX, 5);
  });
});

// ─── familyTreeLayout — multi-parent (diamond / two parents) ─────────────────

describe('familyTreeLayout — multi-parent (child with two different parents)', () => {
  /**
   * P1 --parent--> C
   * P2 --parent--> C
   *
   * C has two parents. Both P1 and P2 are roots.
   * C must appear once in output with y greater than both parents' y.
   */
  const nodes: TestNode[] = [
    { id: 'P1', x: 0, y: 0 },
    { id: 'P2', x: 0, y: 0 },
    { id: 'C', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'P1', target: 'C', label: 'parent' },
    { id: 'e2', source: 'P2', target: 'C', label: 'parent' },
  ];

  it('includes each node id exactly once in the output', () => {
    const result = familyTreeLayout(nodes, edges);
    expect(result.size).toBe(3);
    expect(result.has('P1')).toBe(true);
    expect(result.has('P2')).toBe(true);
    expect(result.has('C')).toBe(true);
  });

  it('places C below both parents (C.y > P1.y and C.y > P2.y)', () => {
    const result = familyTreeLayout(nodes, edges);
    const p1 = result.get('P1')!;
    const p2 = result.get('P2')!;
    const c = result.get('C')!;
    expect(c.y).toBeGreaterThan(p1.y);
    expect(c.y).toBeGreaterThan(p2.y);
  });
});

// ─── familyTreeLayout — cycle safety ─────────────────────────────────────────

describe('familyTreeLayout — cycle safety', () => {
  /**
   * A --parent--> B
   * B --parent--> A   ← creates a cycle
   *
   * Must not throw and must return a finite layout for all nodes.
   */
  const nodes: TestNode[] = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'A', target: 'B', label: 'parent' },
    { id: 'e2', source: 'B', target: 'A', label: 'parent' },
  ];

  it('does not throw for a cyclic graph', () => {
    expect(() => familyTreeLayout(nodes, edges)).not.toThrow();
  });

  it('returns a position for every node (finite layout — no NaN/Infinity)', () => {
    const result = familyTreeLayout(nodes, edges);
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
    for (const [, pos] of result) {
      expect(isFinite(pos.x)).toBe(true);
      expect(isFinite(pos.y)).toBe(true);
    }
  });
});

// ─── familyTreeLayout — non-parent edges ignored ─────────────────────────────

describe('familyTreeLayout — non-parent edges are ignored for positioning', () => {
  /**
   * Nodes A and B connected only by "rival" and "twice-married" edges.
   * Neither is a parent/child — both should appear in the output at
   * deterministic fallback positions (same row, y=0 as roots/isolated).
   */
  const nodes: TestNode[] = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'A', target: 'B', label: 'rival' },
    { id: 'e2', source: 'B', target: 'A', label: 'twice-married' },
  ];

  it('returns positions for all nodes (not thrown out or omitted)', () => {
    const result = familyTreeLayout(nodes, edges);
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
  });

  it('places both nodes at the root level (no parent edges — both are roots)', () => {
    const result = familyTreeLayout(nodes, edges);
    const a = result.get('A')!;
    const b = result.get('B')!;
    // Both are roots (no parent edges pushing them deeper)
    expect(a.y).toBe(b.y);
  });
});

// ─── familyTreeLayout — mixed parent and non-parent edges ────────────────────

describe('familyTreeLayout — mix of parent and non-parent edges', () => {
  /**
   * A --parent--> B  (parent edge — drives layout)
   * A --rival-->  C  (non-parent edge — ignored for layout)
   * C has no parent-term edges, so it's a root.
   */
  const nodes: TestNode[] = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 0, y: 0 },
    { id: 'C', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'A', target: 'B', label: 'parent' },
    { id: 'e2', source: 'A', target: 'C', label: 'rival' },
  ];

  it('places B below A (driven by parent edge)', () => {
    const result = familyTreeLayout(nodes, edges);
    const a = result.get('A')!;
    const b = result.get('B')!;
    expect(b.y).toBeGreaterThan(a.y);
  });

  it('does not use the "rival" edge to alter C position relative to A', () => {
    const result = familyTreeLayout(nodes, edges);
    const a = result.get('A')!;
    const c = result.get('C')!;
    // C is a root (no incoming parent edges) — must be at same y level as A
    expect(c.y).toBe(a.y);
  });

  it('preserves all nodes in output', () => {
    const result = familyTreeLayout(nodes, edges);
    expect(result.size).toBe(3);
  });
});
