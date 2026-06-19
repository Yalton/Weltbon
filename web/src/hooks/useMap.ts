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
  // Joined display fields — injected by the editor from useEntries, NOT returned by the API.
  // API returns bare map_pins rows (no entry join server-side).
  entryTitle?: string;
  entryType?: string;
}

// Phase 40 MAPS-04 (D-09): Region polygon within a map.
export interface MapRegion {
  id: string;
  mapId: string;
  entryId: string | null; // nullable — standalone territory allowed (D-05)
  name: string;
  points: string; // JSON: [{x:number, y:number}, ...] normalized 0..1
  color: string | null; // nullable hex — null means neutral fallback
  createdAt: string;
}

export interface MapDetail {
  id: string;
  universeId: string;
  name: string;
  imageAssetId: string | null;
  rawUrl: string; // pre-signed full-res URL
  thumbUrl: string; // pre-signed thumbnail URL
  createdAt: string;
  legendLabels?: string | null; // JSON: Record<string,string> keyed by "{color}:{icon}"
  pins: MapPin[];
  regions: MapRegion[]; // Phase 40 MAPS-04: widened payload, key UNCHANGED
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
    }) =>
      api<MapRegion>(`/universes/${universeId}/maps/${mapId}/regions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
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
    }: {
      regionId: string;
      name?: string;
      color?: string | null;
      entryId?: string | null;
    }) =>
      api<MapRegion>(
        `/universes/${universeId}/maps/${mapId}/regions/${regionId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ name, color, entryId }),
        },
      ),
    onSuccess: () => {
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
