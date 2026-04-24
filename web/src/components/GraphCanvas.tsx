import type { GraphNode, GraphEdge, GraphPosition } from '../hooks/useGraphData';

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: GraphPosition[];
  width: number;
  height: number;
  onNodeClick: (node: GraphNode) => void;
  onPinNode: (node: GraphNode, x: number, y: number) => void;
  onHoverNode?: (node: GraphNode | null, x: number, y: number) => void;
}

export function GraphCanvas(_props: GraphCanvasProps) {
  // Stub — replaced in GREEN pass.
  return null;
}
