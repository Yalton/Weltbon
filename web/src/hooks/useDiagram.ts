import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface DiagramNode {
  id: string;
  diagramId: string;
  entryId: string;
  x: number;
  y: number;
}

export interface DiagramEdge {
  id: string;
  universeId: string;
  sourceEntryId: string;
  targetEntryId: string;
  label: string | null;
  bidirectional: boolean;
  diagramId: string | null;
  lineStyle: 'solid' | 'dashed' | 'dotted' | null;
  color: string | null;
  createdAt: string;
}

export interface DiagramDetail {
  id: string;
  universeId: string;
  name: string;
  description: string | null;
  createdAt: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export function useDiagram(universeId: string, diagramId: string) {
  return useQuery({
    queryKey: ['diagram', universeId, diagramId],
    queryFn: () =>
      api<DiagramDetail>(`/universes/${universeId}/diagrams/${diagramId}`),
    enabled: !!universeId && !!diagramId,
  });
}

export interface AddNodeInput {
  entryId: string;
  x: number;
  y: number;
}

export function useAddNode(universeId: string, diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddNodeInput) =>
      api<DiagramNode>(
        `/universes/${universeId}/diagrams/${diagramId}/nodes`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['diagram', universeId, diagramId] });
    },
  });
}

export function useRemoveNode(universeId: string, diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) =>
      api<void>(
        `/universes/${universeId}/diagrams/${diagramId}/nodes/${nodeId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['diagram', universeId, diagramId] });
    },
  });
}

export interface MoveNodeInput {
  entryId: string;
  x: number;
  y: number;
}

export function useMoveNode(universeId: string, diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MoveNodeInput) =>
      api<DiagramNode>(
        `/universes/${universeId}/diagrams/${diagramId}/nodes`,
        {
          method: 'PATCH',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['diagram', universeId, diagramId] });
    },
  });
}

export interface CreateEdgeInput {
  sourceEntryId: string;
  targetEntryId: string;
  label?: string | null;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  color?: string;
  bidirectional?: boolean;
}

export function useCreateEdge(universeId: string, diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEdgeInput) =>
      api<DiagramEdge>(
        `/universes/${universeId}/diagrams/${diagramId}/edges`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['diagram', universeId, diagramId] });
    },
  });
}

export function useDeleteEdge(universeId: string, diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edgeId: string) =>
      api<void>(
        `/universes/${universeId}/diagrams/${diagramId}/edges/${edgeId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['diagram', universeId, diagramId] });
    },
  });
}
