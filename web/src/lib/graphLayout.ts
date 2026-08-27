export type GraphPoint = {
  x: number;
  y: number;
};

/**
 * Give unpinned nodes deterministic starting points distributed over the
 * available canvas. d3-force can then refine the arrangement without its
 * default phyllotaxis seed leaving a small graph in the upper-left corner.
 */
export function seededGraphPosition(
  index: number,
  count: number,
  width: number,
  height: number,
): GraphPoint {
  const safeCount = Math.max(1, Math.floor(count));
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const columns = Math.max(
    1,
    Math.ceil(Math.sqrt((safeCount * safeWidth) / safeHeight)),
  );
  const rows = Math.ceil(safeCount / columns);
  const column = Math.max(0, index) % columns;
  const row = Math.floor(Math.max(0, index) / columns);

  return {
    x: (safeWidth * (column + 1)) / (columns + 1),
    y: (safeHeight * (row + 1)) / (rows + 1),
  };
}

/** Place a label on a small perpendicular lane instead of directly on its edge. */
export function edgeLabelPosition(
  source: GraphPoint,
  target: GraphPoint,
  offset = 14,
): GraphPoint {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  const midpoint = {
    x: (source.x + target.x) / 2,
    y: (source.y + target.y) / 2,
  };

  if (length < 0.001) {
    return { x: midpoint.x, y: midpoint.y - offset };
  }

  return {
    x: midpoint.x - (dy / length) * offset,
    y: midpoint.y + (dx / length) * offset,
  };
}
