import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// Query key: ['map', universeId, mapId] — deliberately isolated per react-query-key-change-blast-radius.
// CRITICAL: Do NOT re-key when adding regions — widen the TypeScript type only.
// (react-query-key-change-blast-radius: re-keying breaks sibling exact-key cache ops.)

export interface MapPin {
  id: string;
  mapId: string;
  entryId: string | null;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  color?: string | null; // nullable hex — null means entryTypeHexColor fallback
  icon?: string | null;  // nullable glyph key from mapGlyphs.ts
  // Non-optional — the server always returns it. Share responses never include secret=true pins
  // (they are filtered server-side in getPublicMap / share-views.ts).
  secret: boolean;
  // INCLUDED in share responses (unlike secret) — visitors need it to navigate nested maps.
  // Do NOT re-key ['map', universeId, mapId] when adding this field.
  // (memory: react-query-key-change-blast-radius)
  targetMapId?: string | null;
  // API returns bare map_pins rows (no entry join server-side).
  entryTitle?: string;
  entryType?: string;
  // In auth mode, summary is joined client-side from useEntries in MapEditor (enrichedPins).
  // In share mode, summary comes from the server projection (getPublicMap) — no client-side useEntries join for pins.
  summary?: string | null;
}

// CRITICAL: Do NOT re-key ['map', universeId, mapId] when widening this type.
// (memory: react-query-key-change-blast-radius)
export interface MapRegion {
  id: string;
  mapId: string;
  entryId: string | null; // nullable — standalone territory allowed (D-05)
  name: string;
  points: string; // JSON: [{x:number, y:number}, ...] normalized 0..1
  color: string | null; // nullable hex — null means neutral fallback
  createdAt: string;
  // Share responses never include secret=true regions (filtered in getPublicMap).
  secret: boolean;
  terrainTypeId?: string | null;
  // INCLUDED in share responses (unlike secret) — visitors need it to navigate nested maps.
  // Do NOT re-key ['map', universeId, mapId] when adding this field.
  // (memory: react-query-key-change-blast-radius)
  targetMapId?: string | null;
}

export interface TerrainAreaRegion extends MapRegion {
  terrainTypeId: string;      // guaranteed non-null (discriminator)
  terrainTypeColor: string;   // hex — joined from terrain_types.color
  layerId: string;            // from terrain_types.layer_id
  layerSortOrder: number;     // from map_layers.sort_order, for bottom-to-top stacking
}

// CRITICAL: Do NOT re-key ['map', universeId, mapId] when widening this type.
// (memory: react-query-key-change-blast-radius)
export interface MapRoute {
  id: string;
  mapId: string;
  entryId: string | null;
  name: string;
  points: string; // JSON: [{x:number, y:number}, ...] normalized 0..1
  color: string | null;
  lineStyle: 'solid' | 'dashed';
  width: number;
  showArrow: boolean;
  // Share responses never include secret=true routes (filtered in getPublicMap).
  secret: boolean;
  createdAt: string;
}

export interface MapDetail {
  id: string;
  universeId: string;
  name: string;
  imageAssetId: string | null;
  rawUrl: string | null; // pre-signed full-res URL; null when backing asset was deleted (ON DELETE SET NULL)
  thumbUrl: string | null; // pre-signed thumbnail URL; null when backing asset was deleted (ON DELETE SET NULL)
  createdAt: string;
  legendLabels?: string | null; // JSON: Record<string,string> keyed by "{color}:{icon}"
  pins: MapPin[];
  regions: MapRegion[];
  routes: MapRoute[];
  // and joins terrainTypeColor/layerId/layerSortOrder server-side (no client-side join needed).
  terrainAreas?: TerrainAreaRegion[];
}

export function useMap(universeId: string, mapId: string) {
  return useQuery({
    queryKey: ['map', universeId, mapId],
    queryFn: () => api<MapDetail>(`/universes/${universeId}/maps/${mapId}`),
    enabled: !!universeId && !!mapId,
  });
}

export function useUpdateMap(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; imageAssetId?: string; legendLabels?: string | null }) =>
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


export function useUpdatePinStyle(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      pinId,
      color,
      icon,
    }: {
      pinId: string;
      color?: string | null;
      icon?: string | null;
    }) =>
      api<MapPin>(
        `/universes/${universeId}/maps/${mapId}/pins/${pinId}/style`,
        {
          method: 'PATCH',
          body: JSON.stringify({ color, icon }),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}


export function useCreateRegion(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name?: string;
      points: string; // JSON [{x,y}, ...]
      entryId?: string | null;
      color?: string | null;
      terrainTypeId?: string | null;
    }) =>
      api<MapRegion>(`/universes/${universeId}/maps/${mapId}/regions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

export function useUpdateRegion(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      regionId,
      name,
      color,
      entryId,
      terrainTypeId,
    }: {
      regionId: string;
      name?: string;
      color?: string | null;
      entryId?: string | null;
      terrainTypeId?: string | null;
    }) =>
      api<MapRegion>(
        `/universes/${universeId}/maps/${mapId}/regions/${regionId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ name, color, entryId, terrainTypeId }),
        },
      ),
    onSuccess: () => {
      // CRITICAL: same key — no blast-radius re-key
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

export function useDeleteRegion(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (regionId: string) =>
      api<void>(
        `/universes/${universeId}/maps/${mapId}/regions/${regionId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}


export function useCreateRoute(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name?: string;
      points: string; // JSON [{x,y}, ...]
      entryId?: string | null;
      color?: string | null;
      lineStyle?: 'solid' | 'dashed';
      width?: number;
      showArrow?: boolean;
    }) =>
      api<MapRoute>(`/universes/${universeId}/maps/${mapId}/routes`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

export function useUpdateRoute(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      routeId,
      name,
      color,
      entryId,
      lineStyle,
      width,
      showArrow,
    }: {
      routeId: string;
      name?: string;
      color?: string | null;
      entryId?: string | null;
      lineStyle?: 'solid' | 'dashed';
      width?: number;
      showArrow?: boolean;
    }) =>
      api<MapRoute>(
        `/universes/${universeId}/maps/${mapId}/routes/${routeId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ name, color, entryId, lineStyle, width, showArrow }),
        },
      ),
    onSuccess: () => {
      // CRITICAL: same key — no blast-radius re-key
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

export function useDeleteRoute(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (routeId: string) =>
      api<void>(
        `/universes/${universeId}/maps/${mapId}/routes/${routeId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

// Each mutation PATCHes the respective item with { secret } and invalidates the
// (memory: react-query-key-change-blast-radius)

/**
 * useTogglePinSecret — PATCH .../pins/:pinId/style with { secret }.
 * Rides the existing pinStyleSchema endpoint (52-03 D-01).
 * Invalidates ['map', universeId, mapId] — EXACT key shape, no new segment.
 */
export function useTogglePinSecret(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pinId, secret }: { pinId: string; secret: boolean }) =>
      api<MapPin>(
        `/universes/${universeId}/maps/${mapId}/pins/${pinId}/style`,
        {
          method: 'PATCH',
          body: JSON.stringify({ secret }),
        },
      ),
    onSuccess: () => {
      // CRITICAL: same key — no blast-radius re-key
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

/**
 * useToggleRegionSecret — PATCH .../regions/:regionId with { secret }.
 * Invalidates ['map', universeId, mapId] — EXACT key shape, no new segment.
 */
export function useToggleRegionSecret(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ regionId, secret }: { regionId: string; secret: boolean }) =>
      api<MapRegion>(
        `/universes/${universeId}/maps/${mapId}/regions/${regionId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ secret }),
        },
      ),
    onSuccess: () => {
      // CRITICAL: same key — no blast-radius re-key
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

/**
 * useToggleRouteSecret — PATCH .../routes/:routeId with { secret }.
 * Invalidates ['map', universeId, mapId] — EXACT key shape, no new segment.
 */
export function useToggleRouteSecret(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ routeId, secret }: { routeId: string; secret: boolean }) =>
      api<MapRoute>(
        `/universes/${universeId}/maps/${mapId}/routes/${routeId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ secret }),
        },
      ),
    onSuccess: () => {
      // CRITICAL: same key — no blast-radius re-key
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

// (memory: react-query-key-change-blast-radius)

export function useSetPinTargetMap(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pinId, targetMapId }: { pinId: string; targetMapId: string | null }) =>
      api<MapPin>(
        `/universes/${universeId}/maps/${mapId}/pins/${pinId}/style`,
        {
          method: 'PATCH',
          body: JSON.stringify({ targetMapId }),
        },
      ),
    onSuccess: () => {
      // CRITICAL: same key — no blast-radius re-key
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

export function useSetRegionTargetMap(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ regionId, targetMapId }: { regionId: string; targetMapId: string | null }) =>
      api<MapRegion>(
        `/universes/${universeId}/maps/${mapId}/regions/${regionId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ targetMapId }),
        },
      ),
    onSuccess: () => {
      // CRITICAL: same key — no blast-radius re-key
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}
