

export interface Point {
  x: number;
  y: number;
}

export interface AlignNode {
  id: string;
  x: number;
  y: number;
}

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y';

export type DistributeAxis = 'horizontal' | 'vertical';


export const DEFAULT_GRID_SIZE = 16;


export function snapToGrid(point: Point, gridSize: number): Point {
  if (gridSize <= 0) return { x: point.x, y: point.y };
  return {
    x: Math.round(point.x / gridSize) * gridSize,
    y: Math.round(point.y / gridSize) * gridSize,
  };
}


export function alignNodes(
  nodes: ReadonlyArray<AlignNode>,
  edge: AlignEdge,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return result;

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

  const sorted = [...nodes].sort((a, b) =>
    axis === 'horizontal' ? a.x - b.x : a.y - b.y,
  );

  const n = sorted.length;
  const first = sorted[0];
  const last = sorted[n - 1];

  const totalSpan = axis === 'horizontal' ? last.x - first.x : last.y - first.y;

  // WR-05: degenerate zero-span — all nodes are stacked on the same axis
  // No-op: return original positions, mirroring the < 3 nodes guard.
  if (totalSpan === 0 || !isFinite(totalSpan)) {
    for (const node of nodes) {
      result.set(node.id, { x: node.x, y: node.y });
    }
    return result;
  }

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
