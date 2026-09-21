import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// Query key: ['map-layers', universeId] — deliberately isolated per react-query-key-change-blast-radius.
// All mutations invalidate ONLY this owned key; no cross-domain invalidation.

export interface TerrainType {
  id: string;
  layerId: string;
  name: string;
  color: string;    // hex, never null — auto-assigned at creation
  label: string | null;  // free-text height-range label (D-42-06), nullable
  sortOrder: number;
  createdAt: string;
}

export interface MapLayer {
  id: string;
  universeId: string;
  name: string;
  ordered: boolean;       // true for ranked elevation bands (D-42-02)
  defaultOpacity: number;
  sortOrder: number;
  createdAt: string;
  // Non-optional — server always returns it. Share layer responses filter secret=true layers.
  secret: boolean;
  terrainTypes?: TerrainType[]; // populated when fetched via the GET list (two-query strategy)
}


export function useMapLayers(universeId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['map-layers', universeId],
    queryFn: () => api<MapLayer[]>(`/universes/${universeId}/map-layers`),
    // Gate on the caller's `enabled` so a permanently-mounted-but-hidden panel
    // does not fire a doomed GET /api/share/map-layers → 404 (WR-03).
    enabled: !!universeId && (options?.enabled ?? true),
  });
}


export function useCreateMapLayer(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; ordered?: boolean }) =>
      api<MapLayer>(`/universes/${universeId}/map-layers`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}

export function useUpdateMapLayer(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      layerId,
      ...input
    }: {
      layerId: string;
      name?: string;
      defaultOpacity?: number;
      sortOrder?: number;
    }) =>
      api<MapLayer>(`/universes/${universeId}/map-layers/${layerId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}

export function useDeleteMapLayer(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (layerId: string) =>
      api<void>(`/universes/${universeId}/map-layers/${layerId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}

export function useToggleLayerSecret(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ layerId, secret }: { layerId: string; secret: boolean }) =>
      api<MapLayer>(`/universes/${universeId}/map-layers/${layerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ secret }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}

// ─── Terrain-type mutations ───────────────────────────────────────────────────
// All invalidate ['map-layers', universeId] (terrain types are nested under
// Do NOT introduce a separate ['terrain-types', ...] key (blast-radius landmine).

export function useCreateTerrainType(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      layerId,
      ...input
    }: {
      layerId: string;
      name: string;
      color: string;
      label?: string | null;
    }) =>
      api<TerrainType>(
        `/universes/${universeId}/map-layers/${layerId}/terrain-types`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}

export function useUpdateTerrainType(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      layerId,
      typeId,
      ...input
    }: {
      layerId: string;
      typeId: string;
      name?: string;
      color?: string;
      label?: string | null;
      sortOrder?: number;
    }) =>
      api<TerrainType>(
        `/universes/${universeId}/map-layers/${layerId}/terrain-types/${typeId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}

export function useDeleteTerrainType(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ layerId, typeId }: { layerId: string; typeId: string }) =>
      api<void>(
        `/universes/${universeId}/map-layers/${layerId}/terrain-types/${typeId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}


export function useAddBiomesPreset(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<MapLayer>(`/universes/${universeId}/map-layers/presets/biomes`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}

export function useAddElevationPreset(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<MapLayer>(`/universes/${universeId}/map-layers/presets/elevation`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map-layers', universeId] });
    },
  });
}
