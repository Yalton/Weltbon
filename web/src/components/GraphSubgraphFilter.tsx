import type { GraphNode } from '../hooks/useGraphData';

export interface SubgraphFocus {
  entryId: string;
  hops: number;
}

export interface GraphSubgraphFilterProps {
  nodes: GraphNode[];
  totalCount: number;
  focus: SubgraphFocus | null;
  onFocusChange: (focus: SubgraphFocus | null) => void;
}

/**
 * Stub — full implementation lands in Task 3 GREEN.
 */
export function GraphSubgraphFilter(_props: GraphSubgraphFilterProps) {
  return null;
}
