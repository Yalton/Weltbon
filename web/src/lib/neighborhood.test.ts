import { describe, it, expect } from 'vitest';
import { neighborhood } from './neighborhood';
import type { GraphEdge } from '../hooks/useGraphData';

function edge(id: string, source: string, target: string, direction: string = 'directed'): GraphEdge {
  return { id, source, target, label: null, linkType: null, direction };
}

describe('neighborhood', () => {
  it('returns only the start node when hops=0', () => {
    const edges: GraphEdge[] = [edge('e1', 'A', 'B'), edge('e2', 'B', 'C')];
    const result = neighborhood(edges, 'A', 0);
    expect(Array.from(result).sort()).toEqual(['A']);
  });

  it('returns direct neighbors at hops=1', () => {
    // A — B — C, A — D; starting at A with hops=1 reaches {A, B, D}
    const edges: GraphEdge[] = [
      edge('e1', 'A', 'B'),
      edge('e2', 'B', 'C'),
      edge('e3', 'A', 'D'),
    ];
    const result = neighborhood(edges, 'A', 1);
    expect(Array.from(result).sort()).toEqual(['A', 'B', 'D']);
  });

  it('traverses a 3-hop chain', () => {
    // A — B — C — D — E; starting at A with hops=3 reaches {A, B, C, D}
    const edges: GraphEdge[] = [
      edge('e1', 'A', 'B'),
      edge('e2', 'B', 'C'),
      edge('e3', 'C', 'D'),
      edge('e4', 'D', 'E'),
    ];
    const result = neighborhood(edges, 'A', 3);
    expect(Array.from(result).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('does not include unreachable nodes', () => {
    // Two disconnected components: A — B — C and X — Y
    const edges: GraphEdge[] = [
      edge('e1', 'A', 'B'),
      edge('e2', 'B', 'C'),
      edge('e3', 'X', 'Y'),
    ];
    const result = neighborhood(edges, 'A', 5);
    expect(result.has('X')).toBe(false);
    expect(result.has('Y')).toBe(false);
    expect(Array.from(result).sort()).toEqual(['A', 'B', 'C']);
  });

  it('treats directed and undirected edges identically for neighborhood traversal', () => {
    // Directed A -> B and undirected C <-> B; starting at B should see both A and C at hop 1
    const edgesDirectional: GraphEdge[] = [
      edge('e1', 'A', 'B', 'directed'),
      edge('e2', 'C', 'B', 'undirected'),
    ];
    const result = neighborhood(edgesDirectional, 'B', 1);
    expect(Array.from(result).sort()).toEqual(['A', 'B', 'C']);

    // Also: A can still reach B even though edge is A -> B (directed)
    const fromA = neighborhood(edgesDirectional, 'A', 1);
    expect(Array.from(fromA).sort()).toEqual(['A', 'B']);
  });
});
