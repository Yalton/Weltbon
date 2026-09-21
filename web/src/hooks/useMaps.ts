import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// Query key: ['maps', universeId] — deliberately isolated per react-query-key-change-blast-radius.

export interface MapSummary {
  id: string;
  universeId: string;
  name: string;
  imageAssetId: string | null;
  createdAt: string;
  // Pre-signed serving URLs injected by the maps router (same pattern as assets).
  thumbUrl: string | null;
  rawUrl: string | null;
}

export function useMaps(universeId: string) {
  return useQuery({
    queryKey: ['maps', universeId],
    queryFn: () => api<MapSummary[]>(`/universes/${universeId}/maps`),
    enabled: !!universeId,
  });
}

export function useCreateMap(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; imageAssetId: string }) =>
      api<MapSummary>(`/universes/${universeId}/maps`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maps', universeId] });
    },
  });
}

export function useDeleteMap(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mapId: string) =>
      api<void>(`/universes/${universeId}/maps/${mapId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['maps', universeId] });
    },
  });
}
