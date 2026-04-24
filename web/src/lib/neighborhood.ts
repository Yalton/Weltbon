import type { GraphEdge } from '../hooks/useGraphData';

/**
 * Compute the N-hop neighborhood of a starting node in a graph.
 *
 * Treats edges as undirected for the purpose of visual layout: if either a
 * directional or bidirectional edge connects two nodes, either end can reach
 * the other during neighborhood expansion. This matches how the graph view
 * renders the subgraph filter — the user picks a focus node and wants to see
 * everything connected to it within N hops, regardless of edge direction.
 *
 * - hops=0 returns just {startId}
 * - hops=1 returns {startId} ∪ direct neighbors
 * - hops=N returns all nodes reachable within N edges via BFS
 */
export function neighborhood(
  edges: GraphEdge[],
  startId: string,
  hops: number,
): Set<string> {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }

  const result = new Set<string>([startId]);
  let frontier = new Set<string>([startId]);
  for (let i = 0; i < hops; i++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!result.has(nb)) {
          result.add(nb);
          next.add(nb);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  return result;
}
