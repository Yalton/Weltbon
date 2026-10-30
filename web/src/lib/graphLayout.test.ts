import { describe, it, expect } from 'vitest';
import { forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { applyGraphForces, seededGraphPosition } from './graphLayout';

type Node = SimulationNodeDatum & { id: string };
type Link = SimulationLinkDatum<Node>;

const WIDTH = 1152;
const HEIGHT = 780;

function settle(count: number, links: Link[]): Node[] {
  const nodes: Node[] = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    ...seededGraphPosition(index, count, WIDTH, HEIGHT),
  }));
  const sim = applyGraphForces(forceSimulation<Node, Link>(nodes), links, WIDTH, HEIGHT, () => 30).stop();
  sim.tick(400);
  return nodes;
}

function expectInsideCanvas(nodes: Node[]) {
  for (const { x, y } of nodes) {
    expect(x).toBeGreaterThan(40);
    expect(x).toBeLessThan(WIDTH - 40);
    expect(y).toBeGreaterThan(40);
    expect(y).toBeLessThan(HEIGHT - 40);
  }
}

describe('applyGraphForces', () => {
  it('keeps unlinked entries on the canvas once the layout settles', () => {
    // Without the centre pull the charge alone spread these ten to x -18…1277, y -33…939.
    expectInsideCanvas(settle(10, []));
  });
});
