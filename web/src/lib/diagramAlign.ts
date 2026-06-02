/**
 * diagramAlign — pure geometry helpers for grid snapping, node alignment, and
 * node distribution.
 *
 * Default grid size: 16px (documented for Plan 10 / image-export callers).
 *
 * No React, no d3, no DOM. Pure TypeScript — mirrors the familyTreeLayout /
 * orgChartLayout pure-helper convention.
 *
 * DIAGRAM-01/03 requirements (snap-on-drag + align/distribute over multi-selection).
 * Threat T-31-21 mitigated: all functions return finite numbers only (no NaN/Infinity).
 * Threat T-31-22 (DoS) accepted: O(n log n) sort + O(n) pass, bounded by node count.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal point shape used by snapToGrid. */
export interface Point {
  x: number;
  y: number;
}

/** Minimal node shape used by alignNodes and distributeNodes. */
export interface AlignNode {
  id: string;
  x: number;
  y: number;
}

/** The six supported alignment edges. */
export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y';

/** The two distribution axes. */
export type DistributeAxis = 'horizontal' | 'vertical';

// ─── Default grid size ────────────────────────────────────────────────────────

/**
 * Default grid size in pixels.
 * Chosen as 16px (base spacing token — matches the Tailwind v4 `md` spacing
 * used throughout the canvas). Plan 10 (image export) reads this constant.
 */
export const DEFAULT_GRID_SIZE = 16;

// ─── snapToGrid ──────────────────────────────────────────────────────────────

/**
 * Rounds a point's x and y to the nearest multiple of gridSize.
 *
 * When gridSize <= 0 the input point is returned unchanged (no-op guard).
 * The return value always contains finite numbers (T-31-21 mitigate).
 *
 * @param point    The input point to snap.
 * @param gridSize The grid cell size in pixels. Must be > 0 to enable snapping.
 */
export function snapToGrid(point: Point, gridSize: number): Point {
  if (gridSize <= 0) return { x: point.x, y: point.y };
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  };
}

// ─── alignNodes ──────────────────────────────────────────────────────────────

/**
 * Returns new positions for a set of nodes aligned to a shared reference line.
 *
 * Edge semantics:
 *   - 'left':     every node's x → minimum x in the selection.
 *   - 'right':    every node's x → maximum x in the selection.
 *   - 'top':      every node's y → minimum y in the selection.
 *   - 'bottom':   every node's y → maximum y in the selection.
 *   - 'center-x': every node's x → mean x of the selection.
 *   - 'center-y': every node's y → mean y of the selection.
 *
 * Returns a `Map<nodeId, { x, y }>` containing all input nodes.
 * Empty selection → empty Map. Single node → node unchanged.
 *
 * @param nodes Input nodes — all in the selection (non-selected nodes are NOT passed here).
 * @param edge  The alignment reference edge.
 */
export function alignNodes(
  nodes: ReadonlyArray<AlignNode>,
  edge: AlignEdge,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;

  // Compute reference value based on the requested edge.
  let ref: number;
  switch (edge) {
    case 'left':
      ref = Math.min(...nodes.map((n) => n.x));
      break;
    case 'right':
      ref = Math.max(...nodes.map((n) => n.x));
      break;
    case 'top':
      ref = Math.min(...nodes.map((n) => n.y));
      break;
    case 'bottom':
      ref = Math.max(...nodes.map((n) => n.y));
      break;
    case 'center-x':
      ref = nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length;
      break;
    case 'center-y':
      ref = nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length;
      break;
  }

  for (const node of nodes) {
    switch (edge) {
      case 'left':
      case 'right':
      case 'center-x':
        result.set(node.id, { x: ref, y: node.y });
        break;
      case 'top':
      case 'bottom':
      case 'center-y':
        result.set(node.id, { x: node.x, y: ref });
        break;
    }
  }

  return result;
}

// ─── distributeNodes ─────────────────────────────────────────────────────────

/**
 * Returns new positions for a set of nodes with equal spacing along the given axis.
 *
 * Algorithm:
 *   - Sort nodes by x (horizontal) or y (vertical).
 *   - Fix endpoints (min/max along the axis).
 *   - Space intermediate nodes evenly.
 *   - The perpendicular coordinate (x for vertical, y for horizontal) is preserved.
 *
 * For fewer than 3 nodes the function is a no-op — returns the original positions
 * unchanged (no throw). This is because distribution is meaningless with only
 * 1 or 2 nodes.
 *
 * Returns a `Map<nodeId, { x, y }>` containing all input nodes.
 *
 * @param nodes Input nodes — all in the selection (no filtering applied here).
 * @param axis  The distribution axis ('horizontal' or 'vertical').
 */
export function distributeNodes(
  nodes: ReadonlyArray<AlignNode>,
  axis: DistributeAxis,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;

  // Fewer than 3 nodes — no-op, return original positions.
  if (nodes.length < 3) {
    for (const node of nodes) {
      result.set(node.id, { x: node.x, y: node.y });
    }
    return result;
  }

  // Sort by the distribution axis.
  const sorted = [...nodes].sort((a, b) =>
    axis === 'horizontal' ? a.x - b.x : a.y - b.y,
  );

  const n = sorted.length;
  const first = sorted[0];
  const last = sorted[n - 1];

  // Total span along the axis.
  const totalSpan = axis === 'horizontal' ? last.x - first.x : last.y - first.y;

  // WR-05: degenerate zero-span — all nodes are stacked on the same axis
  // coordinate (e.g. all selected nodes have the same x when distributing
  // horizontally). Distributing would collapse all nodes to first.x (gap = 0/NaN).
  // No-op: return original positions, mirroring the < 3 nodes guard.
  if (totalSpan === 0 || !isFinite(totalSpan)) {
    for (const node of nodes) {
      result.set(node.id, { x: node.x, y: node.y });
    }
    return result;
  }

  // Equal gap between consecutive nodes.
  const gap = totalSpan / (n - 1);

  for (let i = 0; i < n; i++) {
    const node = sorted[i];
    if (axis === 'horizontal') {
      const newX = first.x + i * gap;
      result.set(node.id, { x: newX, y: node.y });
    } else {
      const newY = first.y + i * gap;
      result.set(node.id, { x: node.x, y: newY });
    }
  }

  return result;
}
