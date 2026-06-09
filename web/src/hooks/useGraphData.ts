import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface GraphNode {
  id: string;
  title: string;
  entryType: string;
  summary: string;
  icon: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string | null;
  linkType: string | null;
  direction: string;
}

export interface GraphPosition {
  entryId: string;
  x: number;
  y: number;
}

export interface GraphDataResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: GraphPosition[];
}

export function useGraphData(universeId: string) {
  return useQuery({
    queryKey: ['graph-data', universeId],
    queryFn: () => api<GraphDataResponse>(`/universes/${universeId}/graph-data`),
    enabled: !!universeId,
  });
}
