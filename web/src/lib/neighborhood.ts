import type { GraphEdge } from '../hooks/useGraphData';

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
