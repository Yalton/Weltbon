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
  // Stub — fails all tests until implemented.
  void edges;
  void startId;
  void hops;
  return new Set();
}
