import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

export type GraphPoint = {
  x: number;
  y: number;
};

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

// Without edges nothing pulls nodes together: forceCenter only recentres the centroid, so the
// charge alone spread ten unlinked entries well past the canvas. A weak pull toward the middle
// keeps unlinked entries (and stray islands in a linked graph) on screen.
const CENTER_PULL = 0.05;

/** Installs the graph's forces on `sim`. Shared by GraphCanvas and its layout test. */
export function applyGraphForces<
  N extends SimulationNodeDatum & { id: string },
  L extends SimulationLinkDatum<N>,
>(
  sim: Simulation<N, L>,
  links: L[],
  width: number,
  height: number,
  collisionRadius: (node: N) => number,
): Simulation<N, L> {
  const linkDistance = Math.min(
    220,
    Math.max(120, Math.sqrt((width * height) / Math.max(sim.nodes().length, 1)) * 0.55),
  );
  return sim
    .force(
      'link',
      forceLink<N, L>(links)
        .id((d) => d.id)
        .distance(linkDistance),
    )
    .force('charge', forceManyBody<N>().strength(-Math.min(650, linkDistance * 2.5)))
    .force('center', forceCenter(width / 2, height / 2))
    .force('x', forceX<N>(width / 2).strength(CENTER_PULL))
    .force('y', forceY<N>(height / 2).strength(CENTER_PULL))
    .force('collide', forceCollide<N>(collisionRadius));
}
