import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// Query key: ['map', universeId, mapId] — deliberately isolated per react-query-key-change-blast-radius.
// Singular 'map' (distinct from plural 'maps' list key) matches the useDiagram pattern.
// Do NOT reuse or extend any other domain's query key.

export interface MapPin {
  id: string;
  mapId: string;
  entryId: string;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  // Joined display fields — injected by the editor from useEntries, NOT returned by the API.
  // API returns bare map_pins rows (no entry join server-side).
  entryTitle?: string;
  entryType?: string;
}

export interface MapDetail {
  id: string;
  universeId: string;
  name: string;
  imageAssetId: string | null;
  rawUrl: string; // pre-signed full-res URL
  thumbUrl: string; // pre-signed thumbnail URL
  createdAt: string;
  pins: MapPin[];
}

export function useMap(universeId: string, mapId: string) {
  return useQuery({
    queryKey: ['map', universeId, mapId],
    queryFn: () => api<MapDetail>(`/universes/${universeId}/maps/${mapId}`),
    enabled: !!universeId && !!mapId,
  });
}

/**
 * useUpdateMap — supports rename and/or change-image (imageAssetId) per D-03.
 * Invalidates BOTH the detail key ['map', universeId, mapId] AND the list key
 * ['maps', universeId] so the tile grid reflects the new name/thumbnail.
 */
export function useUpdateMap(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; imageAssetId?: string }) =>
      api<MapDetail>(`/universes/${universeId}/maps/${mapId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
      qc.invalidateQueries({ queryKey: ['maps', universeId] });
    },
  });
}

export function useAddPin(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { entryId: string; x: number; y: number }) =>
      api<MapPin>(`/universes/${universeId}/maps/${mapId}/pins`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

export function useMovePin(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pinId, x, y }: { pinId: string; x: number; y: number }) =>
      api<MapPin>(`/universes/${universeId}/maps/${mapId}/pins/${pinId}`, {
        method: 'PATCH',
        body: JSON.stringify({ x, y }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

/**
 * useRelinkPin — change the entryId of an existing pin (D-07).
 * PATCHes /pins/:pinId/relink with { entryId }.
 */
export function useRelinkPin(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pinId, entryId }: { pinId: string; entryId: string }) =>
      api<MapPin>(
        `/universes/${universeId}/maps/${mapId}/pins/${pinId}/relink`,
        {
          method: 'PATCH',
          body: JSON.stringify({ entryId }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

export function useDeletePin(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pinId: string) =>
      api<void>(`/universes/${universeId}/maps/${mapId}/pins/${pinId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}
