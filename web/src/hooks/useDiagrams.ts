import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface DiagramSummary {
  id: string;
  universeId: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export function useDiagrams(universeId: string) {
  return useQuery({
    queryKey: ['diagrams', universeId],
    queryFn: () => api<DiagramSummary[]>(`/universes/${universeId}/diagrams`),
    enabled: !!universeId,
  });
}

export interface CreateDiagramInput {
  name: string;
  description?: string;
}

export function useCreateDiagram(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDiagramInput) =>
      api<DiagramSummary>(`/universes/${universeId}/diagrams`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['diagrams', universeId] });
    },
  });
}

export function useDeleteDiagram(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (diagramId: string) =>
      api<void>(`/universes/${universeId}/diagrams/${diagramId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['diagrams', universeId] });
    },
  });
}
