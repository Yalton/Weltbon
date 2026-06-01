import { describe, it, expect } from 'vitest';
import { orgChartLayout, MANAGER_TERMS, isManagerEdge } from './orgChartLayout';

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

// ─── MANAGER_TERMS ────────────────────────────────────────────────────────────

describe('MANAGER_TERMS', () => {
  it('contains all expected reporting-line terms', () => {
    const expected = [
      'manager',
      'reports to',
      'supervises',
      'manages',
      'subordinate',
      'lead',
      'leads',
      'head of',
    ];
    expect(MANAGER_TERMS).toHaveLength(expected.length);
    for (const term of expected) {
      expect(MANAGER_TERMS).toContain(term);
    }
  });
});

// ─── isManagerEdge ────────────────────────────────────────────────────────────

describe('isManagerEdge', () => {
  it('returns true for exact lowercase manager terms', () => {
    expect(isManagerEdge({ id: 'e1', source: 'a', target: 'b', label: 'manager' })).toBe(true);
    expect(isManagerEdge({ id: 'e2', source: 'a', target: 'b', label: 'manages' })).toBe(true);
    expect(isManagerEdge({ id: 'e3', source: 'a', target: 'b', label: 'supervises' })).toBe(true);
    expect(isManagerEdge({ id: 'e4', source: 'a', target: 'b', label: 'reports to' })).toBe(true);
    expect(isManagerEdge({ id: 'e5', source: 'a', target: 'b', label: 'head of' })).toBe(true);
  });

  it('returns true for case-insensitive label match ("Reports To" matches "reports to")', () => {
    expect(isManagerEdge({ id: 'e6', source: 'a', target: 'b', label: 'Reports To' })).toBe(true);
    expect(isManagerEdge({ id: 'e7', source: 'a', target: 'b', label: 'MANAGES' })).toBe(true);
    expect(isManagerEdge({ id: 'e8', source: 'a', target: 'b', label: 'Supervises' })).toBe(true);
    expect(isManagerEdge({ id: 'e9', source: 'a', target: 'b', label: 'Head Of' })).toBe(true);
  });

  it('returns false for null label', () => {
    expect(isManagerEdge({ id: 'e10', source: 'a', target: 'b', label: null })).toBe(false);
  });

  it('returns false for empty string label', () => {
    expect(isManagerEdge({ id: 'e11', source: 'a', target: 'b', label: '' })).toBe(false);
  });

  it('returns false for non-manager labels', () => {
    expect(isManagerEdge({ id: 'e12', source: 'a', target: 'b', label: 'rival' })).toBe(false);
    expect(isManagerEdge({ id: 'e13', source: 'a', target: 'b', label: 'spouse' })).toBe(false);
    expect(isManagerEdge({ id: 'e14', source: 'a', target: 'b', label: 'parent' })).toBe(false);
  });
});

// ─── orgChartLayout — simple manager->three-reports tree ─────────────────────

describe('orgChartLayout — manager with three direct reports', () => {
  /**
   * Tree:
   *        Manager (A)
   *      /      |      \
   *   IC1(B)  IC2(C)  IC3(D)
   *
   * Edges:
   *   A --manages--> B  (A is the manager of B)
   *   A --manages--> C  (A is the manager of C)
   *   A --manages--> D  (A is the manager of D)
   *
   * Convention: edge label "manages" means source is the manager of target.
   * A has no incoming manager edges → A is the root (top of hierarchy).
   */
  const nodes: TestNode[] = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 0, y: 0 },
    { id: 'C', x: 0, y: 0 },
    { id: 'D', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'A', target: 'B', label: 'manages' },
    { id: 'e2', source: 'A', target: 'C', label: 'manages' },
    { id: 'e3', source: 'A', target: 'D', label: 'manages' },
  ];

  it('returns a position for every node id', () => {
    const result = orgChartLayout(nodes, edges);
    expect(result.get('A')).toBeDefined();
    expect(result.get('B')).toBeDefined();
    expect(result.get('C')).toBeDefined();
    expect(result.get('D')).toBeDefined();
  });

  it('places direct reports below the manager (manager.y < report.y)', () => {
    const result = orgChartLayout(nodes, edges);
    const manager = result.get('A')!;
    const b = result.get('B')!;
    const c = result.get('C')!;
    const d = result.get('D')!;
    expect(manager.y).toBeLessThan(b.y);
    expect(manager.y).toBeLessThan(c.y);
    expect(manager.y).toBeLessThan(d.y);
  });

  it('places all direct reports on the same row (same y)', () => {
    const result = orgChartLayout(nodes, edges);
    const b = result.get('B')!;
    const c = result.get('C')!;
    const d = result.get('D')!;
    expect(b.y).toBe(c.y);
    expect(b.y).toBe(d.y);
  });

  it('places the manager horizontally centered above its reports', () => {
    const result = orgChartLayout(nodes, edges);
    const manager = result.get('A')!;
    const b = result.get('B')!;
    const c = result.get('C')!;
    const d = result.get('D')!;
    const avgX = (b.x + c.x + d.x) / 3;
    expect(manager.x).toBeCloseTo(avgX, 5);
  });
});

// ─── orgChartLayout — single-parent enforcement ────────────────────────────

describe('orgChartLayout — single-parent enforcement', () => {
  /**
   * M1 --manages--> IC
   * M2 --manages--> IC
   *
   * IC has two manager edges. Single-parent rule: IC is placed under M1 (first
   * encountered in deterministic order). IC must appear exactly once in output.
   */
  const nodes: TestNode[] = [
    { id: 'M1', x: 0, y: 0 },
    { id: 'M2', x: 0, y: 0 },
    { id: 'IC', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'M1', target: 'IC', label: 'manages' },
    { id: 'e2', source: 'M2', target: 'IC', label: 'manages' },
  ];

  it('includes each node id exactly once in the output', () => {
    const result = orgChartLayout(nodes, edges);
    expect(result.size).toBe(3);
    expect(result.has('M1')).toBe(true);
    expect(result.has('M2')).toBe(true);
    expect(result.has('IC')).toBe(true);
  });

  it('places IC below exactly one manager level (single-parent — not multi-parent)', () => {
    const result = orgChartLayout(nodes, edges);
    const m1 = result.get('M1')!;
    const m2 = result.get('M2')!;
    const ic = result.get('IC')!;
    // IC should be below at least one manager
    const belowM1 = ic.y > m1.y;
    const belowM2 = ic.y > m2.y;
    expect(belowM1 || belowM2).toBe(true);
  });
});

// ─── orgChartLayout — multi-level chain ───────────────────────────────────

describe('orgChartLayout — multi-level chain (CEO -> VP -> IC)', () => {
  /**
   * CEO --manages--> VP --manages--> IC
   *
   * Three distinct depth levels: CEO at 0, VP at 1, IC at 2.
   */
  const nodes: TestNode[] = [
    { id: 'CEO', x: 0, y: 0 },
    { id: 'VP', x: 0, y: 0 },
    { id: 'IC', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'CEO', target: 'VP', label: 'manages' },
    { id: 'e2', source: 'VP', target: 'IC', label: 'manages' },
  ];

  it('produces three distinct descending depth levels', () => {
    const result = orgChartLayout(nodes, edges);
    const ceo = result.get('CEO')!;
    const vp = result.get('VP')!;
    const ic = result.get('IC')!;
    expect(ceo.y).toBeLessThan(vp.y);
    expect(vp.y).toBeLessThan(ic.y);
  });

  it('returns a position for every node id', () => {
    const result = orgChartLayout(nodes, edges);
    expect(result.has('CEO')).toBe(true);
    expect(result.has('VP')).toBe(true);
    expect(result.has('IC')).toBe(true);
  });
});

// ─── orgChartLayout — cycle safety ────────────────────────────────────────

describe('orgChartLayout — cycle safety', () => {
  /**
   * A --manages--> B
   * B --manages--> A   ← creates a cycle
   *
   * Must not throw and must return a finite layout for all nodes.
   */
  const nodes: TestNode[] = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'A', target: 'B', label: 'manages' },
    { id: 'e2', source: 'B', target: 'A', label: 'manages' },
  ];

  it('does not throw for a cyclic graph', () => {
    expect(() => orgChartLayout(nodes, edges)).not.toThrow();
  });

  it('returns a position for every node (finite layout — no NaN/Infinity)', () => {
    const result = orgChartLayout(nodes, edges);
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
    for (const [, pos] of result) {
      expect(isFinite(pos.x)).toBe(true);
      expect(isFinite(pos.y)).toBe(true);
    }
  });
});

// ─── orgChartLayout — non-manager edges ignored ───────────────────────────

describe('orgChartLayout — non-manager edges are ignored for positioning', () => {
  /**
   * Nodes A and B connected only by "rival" and "spouse" edges.
   * Neither is a manager/report — both should appear in the output at
   * deterministic fallback positions (same row, y=0 as roots/isolated).
   */
  const nodes: TestNode[] = [
    { id: 'A', x: 0, y: 0 },
    { id: 'B', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'A', target: 'B', label: 'rival' },
    { id: 'e2', source: 'B', target: 'A', label: 'spouse' },
  ];

  it('returns positions for all nodes (not thrown out or omitted)', () => {
    const result = orgChartLayout(nodes, edges);
    expect(result.has('A')).toBe(true);
    expect(result.has('B')).toBe(true);
  });

  it('places both nodes at the root level (no manager edges — both are roots)', () => {
    const result = orgChartLayout(nodes, edges);
    const a = result.get('A')!;
    const b = result.get('B')!;
    // Both are roots (no manager edges pushing them deeper)
    expect(a.y).toBe(b.y);
  });
});

// ─── orgChartLayout — case-insensitive MANAGER_TERMS matching ─────────────

describe('orgChartLayout — case-insensitive MANAGER_TERMS matching', () => {
  /**
   * Boss --"Reports To"--> IC  (note: uppercase-ish label)
   *
   * Directionality: "reports to" means source reports to target. So the
   * source (Boss) points its manager-role label toward IC. In the org-chart
   * BFS, "reports to" is: source is the subordinate, target is the manager.
   * That means IC (target) has no manager and is a root; Boss (source) is
   * one level below.
   *
   * HOWEVER: for all other MANAGER_TERMS ("manages", "supervises", "leads",
   * "manager", "lead", "subordinate", "head of") the source is the manager
   * and the target is the subordinate — the convention that source claims
   * manager role over target.
   *
   * For this test we use "manages" with mixed case to test case-insensitivity.
   */
  const nodes: TestNode[] = [
    { id: 'CEO', x: 0, y: 0 },
    { id: 'IC', x: 0, y: 0 },
  ];
  const edges: TestEdge[] = [
    { id: 'e1', source: 'CEO', target: 'IC', label: 'Manages' }, // mixed case
  ];

  it('recognizes mixed-case manager terms and drives layout', () => {
    const result = orgChartLayout(nodes, edges);
    const ceo = result.get('CEO')!;
    const ic = result.get('IC')!;
    // CEO --"Manages"--> IC: CEO is manager (depth 0), IC is subordinate (depth 1)
    expect(ceo.y).toBeLessThan(ic.y);
  });

  it('isManagerEdge returns false for null label (explicit)', () => {
    expect(isManagerEdge({ id: 'e1', source: 'a', target: 'b', label: null })).toBe(false);
  });
});
