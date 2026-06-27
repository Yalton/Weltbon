import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// Query key: ['map', universeId, mapId] — deliberately isolated per react-query-key-change-blast-radius.
// Singular 'map' (distinct from plural 'maps' list key) matches the useDiagram pattern.
// Do NOT reuse or extend any other domain's query key.
// CRITICAL: Do NOT re-key when adding regions — widen the TypeScript type only.
// (react-query-key-change-blast-radius: re-keying breaks sibling exact-key cache ops.)

export interface MapPin {
  id: string;
  mapId: string;
  entryId: string;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  // Phase 40 MAPS-05 style overrides (D-01, D-02):
  color?: string | null; // nullable hex — null means entryTypeHexColor fallback
  icon?: string | null;  // nullable glyph key from mapGlyphs.ts
  // Phase 52 SECRET-01: owner-only secret flag (false = visible; true = hidden from share).
  // Non-optional — the server always returns it. Share responses never include secret=true pins
  // (they are filtered server-side in getPublicMap / share-views.ts).
  secret: boolean;
  // Joined display fields — injected by the editor from useEntries, NOT returned by the API.
  // API returns bare map_pins rows (no entry join server-side).
  entryTitle?: string;
  entryType?: string;
  // Phase 50 MAP-UI-03 (D-09): share-projected from entries.summary for tooltip excerpt parity.
  // In auth mode, summary is joined client-side from useEntries in MapEditor (enrichedPins).
  // In share mode, summary comes from the server projection (getPublicMap) — no client-side useEntries join for pins.
  summary?: string | null;
}

// Phase 40 MAPS-04 (D-09): Region polygon within a map.
// Phase 43 TERRAIN-01: terrainTypeId discriminator added (null = political/standalone; set = terrain area).
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
  // Phase 52 SECRET-01: owner-only secret flag. Non-optional — server always returns it.
  // Share responses never include secret=true regions (filtered in getPublicMap).
  secret: boolean;
  // Phase 43: terrain discriminator — null = political/standalone; non-null = terrain area
  terrainTypeId?: string | null;
}

/**
 * Phase 43 TERRAIN-01: Enriched variant of MapRegion for terrain area rendering.
 * Built client-side in MapEditor by joining MapRegion against useMapLayers data.
 * NOT returned by the API directly — discriminator is in terrain_type_id column,
 * color + layerId + layerSortOrder are joined from terrain_types/map_layers.
 */
export interface TerrainAreaRegion extends MapRegion {
  terrainTypeId: string;      // guaranteed non-null (discriminator)
  terrainTypeColor: string;   // hex — joined from terrain_types.color
  layerId: string;            // from terrain_types.layer_id
  layerSortOrder: number;     // from map_layers.sort_order, for bottom-to-top stacking
}

// Phase 51 ROUTE-01: Route polyline within a map.
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
  // Phase 52 SECRET-01: owner-only secret flag. Non-optional — server always returns it.
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
  regions: MapRegion[]; // Phase 40 MAPS-04: widened payload, key UNCHANGED
  routes: MapRoute[]; // Phase 51 ROUTE-01: widened payload, key UNCHANGED
  // Phase 44 GEOSHARE-01: terrain areas pre-enriched by the share seam (D-44-03).
  // Only populated on share map detail responses; undefined in authenticated responses.
  // In share mode, the API discriminates terrainTypeId IS NOT NULL rows into this group
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

/**
 * useUpdateMap — supports rename, change-image (imageAssetId), and legendLabels
 * update per D-03. Invalidates BOTH the detail key ['map', universeId, mapId] AND
 * the list key ['maps', universeId] so the tile grid reflects the new name/thumbnail.
 */
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

// ─── Phase 40 MAPS-05: Pin style mutation ────────────────────────────────────

/**
 * useUpdatePinStyle — update a pin's color and/or icon (D-01, D-02).
 * PATCHes /pins/:pinId/style with { color, icon }.
 * Invalidates the existing ['map', universeId, mapId] key — no new key (landmine).
 */
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

// ─── Phase 40 MAPS-04: Region mutations ──────────────────────────────────────

/**
 * useCreateRegion — POST .../regions to create a new region polygon (D-04, D-09).
 * Invalidates ['map', universeId, mapId] so the canvas re-renders.
 */
export function useCreateRegion(universeId: string, mapId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name?: string;
      points: string; // JSON [{x,y}, ...]
      entryId?: string | null;
      color?: string | null;
      // Phase 43 TERRAIN-01: optional terrain discriminator
      terrainTypeId?: string | null;
    }) =>
      api<MapRegion>(`/universes/${universeId}/maps/${mapId}/regions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      // CRITICAL: invalidate the EXISTING key — do NOT change the key shape
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

/**
 * useUpdateRegion — PATCH .../regions/:regionId (rename, recolor, relink D-06).
 * Invalidates the existing map key — no new key.
 */
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
      // Phase 43 TERRAIN-01: for reclassify — sets the terrain area's type (D-43-02/D-43-03)
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

/**
 * useDeleteRegion — DELETE .../regions/:regionId (D-06).
 * Never touches the linked entry — only removes the region record.
 */
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

// ─── Phase 51 ROUTE-01: Route mutations ──────────────────────────────────────

/**
 * useCreateRoute — POST .../routes to create a new route polyline (ROUTE-01).
 * Invalidates ['map', universeId, mapId] so the canvas re-renders.
 */
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
      // CRITICAL: invalidate the EXISTING key — do NOT change the key shape
      // (memory: react-query-key-change-blast-radius)
      qc.invalidateQueries({ queryKey: ['map', universeId, mapId] });
    },
  });
}

/**
 * useUpdateRoute — PATCH .../routes/:routeId (rename, recolor, relink, restyle).
 * Invalidates the existing map key — no new key.
 */
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

/**
 * useDeleteRoute — DELETE .../routes/:routeId.
 * Never touches the linked entry — only removes the route record.
 */
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

// ─── Phase 52 SECRET-01: Secret toggle mutations ──────────────────────────────
// Each mutation PATCHes the respective item with { secret } and invalidates the
// EXISTING ['map', universeId, mapId] key verbatim — no new key segment.
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
