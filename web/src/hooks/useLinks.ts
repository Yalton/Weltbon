import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface Link {
  id: string;
  universeId: string;
  sourceEntryId: string;
  targetEntryId: string;
  label: string | null;
  linkType: string | null;
  direction: string;
  createdAt: string;
}

export interface RelationCount {
  label: string;
  count: number;
}

export interface LinkTypeCount {
  linkType: string;
  count: number;
}

export type CreateLinkInput = {
  sourceEntryId: string;
  targetEntryId: string;
  label?: string | null;
  linkType?: string | null;
  direction?: 'directed' | 'undirected';
};

export type PatchLinkInput = {
  label?: string | null;
  linkType?: string | null;
  direction?: 'directed' | 'undirected';
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
      // A newly-typed label should appear in the relation combobox next time
      qc.invalidateQueries({ queryKey: ['relations', universeId] });
      // GRAPH-04 fix: useGraphData is keyed ['graph-data', universeId] (see
      // canonical pattern at useGraphPositions.ts:31-33).
      qc.invalidateQueries({ queryKey: ['graph-data', universeId] });
      // Invalidate link-types so the LinkTypeSelect combobox reflects the
      qc.invalidateQueries({ queryKey: ['link-types', universeId] });
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
      qc.invalidateQueries({ queryKey: ['relations', universeId] });
      // Defense-in-depth parity with useCreateLink: any future delete-from-
      // graph caller must see the graph re-render without a full reload.
      qc.invalidateQueries({ queryKey: ['graph-data', universeId] });
    },
  });
}

export function usePatchLink(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId, ...body }: { linkId: string } & PatchLinkInput) =>
      api<Link>(`/universes/${universeId}/links/${linkId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['entry', universeId] });
    qc.invalidateQueries({ queryKey: ['graph-data', universeId] });
    qc.invalidateQueries({ queryKey: ['relations', universeId] });
    qc.invalidateQueries({ queryKey: ['link-types', universeId] });
  },
  });
}

export function useRelations(universeId: string) {
  return useQuery({
    queryKey: ['relations', universeId],
    queryFn: () => api<RelationCount[]>(`/universes/${universeId}/relations`),
    enabled: !!universeId,
  });
}

export function useLinkTypes(universeId: string) {
  return useQuery({
    queryKey: ['link-types', universeId],
    queryFn: () => api<LinkTypeCount[]>(`/universes/${universeId}/link-types`),
    enabled: !!universeId,
  });
}
