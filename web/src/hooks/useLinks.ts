import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface Link {
  id: string;
  universeId: string;
  sourceEntryId: string;
  targetEntryId: string;
  label: string;
  bidirectional: boolean;
  createdAt: string;
}

export type CreateLinkInput = {
  sourceEntryId: string;
  targetEntryId: string;
  label: string;
  bidirectional?: boolean;
};

export function useCreateLink(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateLinkInput) =>
      api<Link>(`/universes/${universeId}/links`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}

export function useDeleteLink(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) =>
      api<void>(`/universes/${universeId}/links/${linkId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}

export function useRelations(universeId: string) {
  return useQuery({
    queryKey: ['relations', universeId],
    queryFn: () => api<string[]>(`/universes/${universeId}/relations`),
    enabled: !!universeId,
  });
}
