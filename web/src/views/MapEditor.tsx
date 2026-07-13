import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { AddEntriesPicker } from '../components/AddEntriesPicker';
import { AssetPickerModal } from '../components/AssetPickerModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { MapBreadcrumb } from '../components/MapBreadcrumb';
import { MapCanvas, type MapCanvasHandle } from '../components/MapCanvas';
import { MapCompass } from '../components/MapCompass';
import { MapPickerModal } from '../components/MapPickerModal';
import { MapZoomControls } from '../components/MapZoomControls';
import { LayersPanel } from '../components/LayersPanel';
import { MapLegend } from '../components/MapLegend';
import { MapToolbar } from '../components/MapToolbar';
import { Toast } from '../components/Toast';
import { useEntries } from '../hooks/useEntries';
import { useEntryMedallions } from '../hooks/useEntryMedallions';
import {
  useAddPin,
  useCreateRegion,
  useCreateRoute,
  useDeletePin,
  useDeleteRegion,
  useDeleteRoute,
  useMap,
  useMovePin,
  useRelinkPin,
  useUpdateMap,
  useUpdatePinStyle,
  useUpdateRegion,
  useUpdateRoute,
  useTogglePinSecret,
  useToggleRegionSecret,
  useToggleRouteSecret,
  useSetPinTargetMap,
  useSetRegionTargetMap,
  type MapPin,
  type MapRegion,
  type MapRoute,
  type TerrainAreaRegion,
} from '../hooks/useMap';
import { useMapLayers } from '../hooks/useMapLayers';
import { useMaps } from '../hooks/useMaps';
import { MAP_COLOR_PALETTE, MAP_GLYPH_KEYS, getGlyphPath } from '../lib/mapGlyphs';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import { useShareMode, useShareToken } from '../contexts/ShareModeContext';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Natural dimensions of the map image.
 * We pre-load the image to get its intrinsic width/height for coordinate
 * conversion. 1200×800 is the default until loaded.
 */
const DEFAULT_IMAGE_WIDTH = 1200;
const DEFAULT_IMAGE_HEIGHT = 800;

// ─── Locked copy (UI-SPEC Copywriting Contract) ───────────────────────────────
const COPY = {
  loading: 'Loading map...',
  error: "Couldn't load map. Refresh the page.",
  hintBanner: 'Click the map to place a pin · Esc to cancel',
  drawRegionBanner: 'Click to add vertices · Enter or click first vertex to close · Esc to cancel',
  noPinsTitle: 'No pins yet',
  noPinsBody: 'Switch to Add pin mode and click the map to place your first entry link.',
  noPinsCta: 'Add pin',
  pinSaveError: "Couldn't save pin. Try again.",
  pinDeleteError: "Couldn't delete pin. Try again.",
  regionSaveError: "Couldn't save region. Try again.",
  regionDeleteError: "Couldn't delete region. Try again.",
  deletePinTitle: (entryTitle: string) => `Delete pin for "${entryTitle}"?`,
  deletePinBody:
    'This removes the pin from the map. The linked entry is not affected.',
  deletePinConfirm: 'Delete pin',
  deleteRegionTitle: (name: string) => `Delete region "${name}"?`,
  deleteRegionBody: 'This removes the region from the map. The linked entry is not affected.',
  deleteRegionConfirm: 'Delete region',
  contextMenuDelete: 'Delete pin',
  contextMenuRelink: 'Change entry...',
  regionContextMenuDelete: 'Delete region',
  regionContextMenuRelink: 'Change entry...',
  regionContextMenuRename: 'Rename...',
  regionContextMenuColor: 'Change color...',
  // Terrain paint copy (43-04)
  paintTerrainBanner: (name: string) =>
    `Painting "${name}" · click to add vertices · Enter or first vertex to close · Esc to cancel`,
  terrainSaveError: "Couldn't save terrain area. Try again.",
  terrainDeleteError: "Couldn't delete terrain area. Try again.",
  terrainReclassifyError: "Couldn't reclassify. Try again.",
  terrainContextMenuDelete: 'Delete area',
  terrainContextMenuReclassify: 'Reclassify ▸',
  // Route draw copy (51-07 ROUTE-01/02)
  drawRouteBanner: 'Click to add vertices · Enter or double-click to finish · Esc to cancel',
  routeSaveError: "Couldn't save route. Try again.",
  routeDeleteError: "Couldn't delete route. Try again.",
  deleteRouteTitle: (name: string) => `Delete route "${name}"?`,
  deleteRouteBody: 'This removes the route from the map. The linked entry is not affected.',
  deleteRouteConfirm: 'Delete route',
  routeContextMenuDelete: 'Delete route',
  routeContextMenuRelink: 'Change entry...',
  routeContextMenuRename: 'Rename...',
  routeContextMenuColor: 'Change color...',
  routeContextMenuLineStyle: (current: string) => current === 'dashed' ? 'Solid line' : 'Dashed line',
  routeContextMenuArrow: (on: boolean) => on ? 'Remove arrow' : 'Add arrow',
  // Phase 52 SECRET-01: context-menu items for toggling secret status on pins/regions/routes/layers.
  contextMenuMarkSecret: 'Mark secret',
  contextMenuUnmarkSecret: 'Unmark secret',
  // Phase 53 NEST-01 D-01: map-link context menu items (UI-SPEC Copywriting Contract).
  linkToMap: 'Link to map…',    // 'Link to map…' — literal ellipsis character
  unlinkMap: 'Unlink map',
  linkMapError: "Couldn't link the map. Try again.",
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type ToastState = { message: string; variant: 'error' | 'success' } | null;

// Phase 52 SEARCH-01: client-side search result type (D-06).
// Each result carries the item type, its database id, a display label, and the
// normalized (0..1) image-space coordinates for panZoomTo.
type SearchResult = {
  type: 'pin' | 'region' | 'route';
  id: string;
  label: string;
  nx: number;
  ny: number;
};

/** State for the positioned pin context menu. */
type ContextMenuState = {
  pin: MapPin;
  clientX: number;
  clientY: number;
} | null;

/** State for the positioned region context menu. */
type RegionContextMenuState = {
  region: MapRegion;
  clientX: number;
  clientY: number;
} | null;

/** State for the positioned terrain area context menu. */
type TerrainContextMenuState = {
  region: TerrainAreaRegion;
  clientX: number;
  clientY: number;
} | null;

/** State for the positioned route context menu (ROUTE-02, Plan 07). */
type RouteContextMenuState = {
  route: MapRoute;
  clientX: number;
  clientY: number;
} | null;

// ─── MapEditor ────────────────────────────────────────────────────────────────

/**
 * `/universes/:uid/maps/:mid` — map editor view.
 *
 * Orchestrates: MapCanvas, MapToolbar, MapLegend, AddEntriesPicker,
 * AssetPickerModal, ConfirmDialog (delete pin/region), Toast, EmptyState overlay.
 *
 * Add-pin flow (D-05): addPinMode → canvas click captures coords → opens
 * AddEntriesPicker → onAdd(entryId) calls useAddPin → picker stays open for
 * additional placements; addPinMode stays active.
 *
 * Draw-region flow (D-04): drawRegionMode → canvas click appends vertex to
 * pendingVertices → rubber-band preview → close via first-vertex click (≥3 verts)
 * or Enter key → useCreateRegion POST → optionally link entry via picker.
 *
 * Drag-reposition (D-06): MapCanvas onPinDragEnd → useMovePin.
 * Click pin: MapCanvas PinCircle distinguishes click from drag; navigates
 * to /universes/:uid/entries/:entryId same-tab.
 *
 * Left-click region with linked entry → navigate to entry detail (D-08-click).
 * Right-click region → region context menu (recolor/relink/rename/delete) (D-06).
 *
 * Change image (D-03): AssetPickerModal → useUpdateMap({ imageAssetId }).
 * Stored pin normalized coords are preserved unchanged.
 *
 * Esc priority (mirrors DiagramEditor layered useEffects):
 *   1. Entry picker / region entry picker open → close picker.
 *   2. drawRegionMode active + pending vertices → clear vertices (Esc mid-draw).
 *   3. Context menu open (pin or region) → close menu.
 *   4. addPinMode / drawRegionMode active (no picker/menu/vertices) → exit mode.
 *
 * Pins are joined with useEntries(uid) to supply entryTitle/entryType before
 * passing to MapCanvas — the API returns bare map_pins rows without entry join.
 */
export function MapEditor() {
  // In share mode there is no :uid param — use 'share' placeholder so hooks
  // interpolate /universes/share/maps/:mid, which the api/client.ts seam
  // rewrites to /api/share/maps/:mid (strips the /universes/<anything> prefix).
  const { uid: paramUid, mid = '' } = useParams<{ uid: string; mid: string }>();
  const isShare = useShareMode();
  const shareToken = useShareToken();
  const uid = paramUid ?? (isShare ? 'share' : '');
  const navigate = useNavigate();
  // Phase 53 NEST-01 D-03: read origin from router nav state (`navigate(to, { state: { from } })`).
  // Cast is safe — only MapEditor/MapBreadcrumb ever write this key.
  const location = useLocation();
  const fromOrigin = (location.state as { from?: { name: string; id: string } } | null)?.from ?? null;

  // ── Data hooks ───────────────────────────────────────────────────────────────
  const { data: map, isLoading, isError } = useMap(uid, mid);
  const { data: entriesData } = useEntries(uid);
  // Content-Forward Views §6 — tooltip identity: cover/icon/monogram for the hover tooltip,
  // resolved from the same entries LIST cache as entriesData above (no second request).
  const medallions = useEntryMedallions(uid);
  // Phase 44 GEOSHARE-01: enable the layers query in share mode.
  // The transparent client seam (api/client.ts) translates
  // /universes/share/map-layers → /api/share/map-layers, now served by 44-02.
  // Do NOT re-key queryKey (['map-layers', uid]) — memory react-query-key-change-blast-radius.
  const { data: layers = [] } = useMapLayers(uid, { enabled: !!uid });
  const addPin = useAddPin(uid, mid);
  const movePin = useMovePin(uid, mid);
  const deletePin = useDeletePin(uid, mid);
  const relinkPin = useRelinkPin(uid, mid);
  const updateMap = useUpdateMap(uid, mid);
  const updatePinStyle = useUpdatePinStyle(uid, mid);
  const createRegion = useCreateRegion(uid, mid);
  const updateRegion = useUpdateRegion(uid, mid);
  const deleteRegion = useDeleteRegion(uid, mid);
  // Phase 51 ROUTE-01/02 (Plan 07): route mutations — draw, restyle, rename, relink, delete.
  const createRoute = useCreateRoute(uid, mid);
  const updateRoute = useUpdateRoute(uid, mid);
  const deleteRoute = useDeleteRoute(uid, mid);
  // Phase 52 SECRET-01: secret-toggle mutations for pin, region, route.
  // Invalidate ONLY the existing ['map', uid, mid] key — no new key segments.
  // (memory: react-query-key-change-blast-radius)
  // Layer secret toggle lives in LayersPanel.tsx (it already owns all layer mutations directly).
  const togglePinSecret = useTogglePinSecret(uid, mid);
  const toggleRegionSecret = useToggleRegionSecret(uid, mid);
  const toggleRouteSecret = useToggleRouteSecret(uid, mid);
  // Phase 53 NEST-01 D-01: set/clear target map on pins and regions.
  // Rides the existing /pins/:pinId/style + /regions/:regionId PATCH endpoints (53-02 precedent).
  // Invalidate ONLY the existing ['map', uid, mid] key (memory: react-query-key-change-blast-radius).
  const setPinTargetMap = useSetPinTargetMap(uid, mid);
  const setRegionTargetMap = useSetRegionTargetMap(uid, mid);
  // Phase 53 NEST-01: universe maps list for "Opens: {mapName}" indicator in context menus.
  // ['maps', uid] key — isolated from ['map', uid, mid] per react-query-key-change-blast-radius.
  const { data: allMaps = [] } = useMaps(uid);

  // ── Image dimensions (loaded from the rawUrl to get intrinsic size) ──────────
  const [imageWidth, setImageWidth] = useState(DEFAULT_IMAGE_WIDTH);
  const [imageHeight, setImageHeight] = useState(DEFAULT_IMAGE_HEIGHT);

  // Load image dimensions when rawUrl becomes available.
  useEffect(() => {
    if (!map?.rawUrl) return;
    const img = new Image();
    img.onload = () => {
      setImageWidth(img.naturalWidth || DEFAULT_IMAGE_WIDTH);
      setImageHeight(img.naturalHeight || DEFAULT_IMAGE_HEIGHT);
    };
    img.src = map.rawUrl;
  }, [map?.rawUrl]);

  // ── UI state ─────────────────────────────────────────────────────────────────
  const [addPinMode, setAddPinMode] = useState(false);
  const [pendingPinCoords, setPendingPinCoords] = useState<{ x: number; y: number } | null>(null);
  const [entryPickerOpen, setEntryPickerOpen] = useState(false);
  const [changeImageOpen, setChangeImageOpen] = useState(false);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [deletePinTarget, setDeletePinTarget] = useState<MapPin | null>(null);
  const [relinkPickerOpen, setRelinkPickerOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [legendVisible, setLegendVisible] = useState(false);
  const [layersPanelVisible, setLayersPanelVisible] = useState(false);
  // Grid overlay toggle — off by default (D-05). Mirrors legendVisible/layersPanelVisible pattern.
  const [gridVisible, setGridVisible] = useState(false);
  // Imperative zoom handle — wired to MapZoomControls onZoomIn/onZoomOut/onFitReset callbacks.
  const canvasRef = useRef<MapCanvasHandle>(null);

  // ── Phase 52 SEARCH-01: in-map search state (D-04, D-05, D-06, D-07) ─────────
  // searchQuery is controlled by MapToolbar's search input (editor + share mode).
  // searchInputRef is forwarded to the input element for the `/` focus shortcut (D-04).
  // highlightedItemId is set on result select; MapCanvas renders a pulse on that item;
  //   cleared after the pulse animation completes (D-05a).
  // selectedResultIndex tracks arrow-key navigation in the dropdown (-1 = no selection).
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [selectedResultIndex, setSelectedResultIndex] = useState(-1);

  // Color picker for LayersPanel terrain-type swatches (onRequestColorPick wiring).
  // When the LayersPanel requests a color pick, we open this dialog and forward
  // the selected color to the `layersColorPickerCallback` function.
  const [layersColorPickerOpen, setLayersColorPickerOpen] = useState(false);
  const [layersColorPickerCurrent, setLayersColorPickerCurrent] = useState('#000000');
  const [layersColorPickerCallback, setLayersColorPickerCallback] = useState<((hex: string) => void) | null>(null);

  // Phase 53 NEST-01 D-01: map picker state.
  // mapPickerPin XOR mapPickerRegion is set while the picker is open (whichever context menu triggered it).
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [mapPickerPin, setMapPickerPin] = useState<MapPin | null>(null);
  const [mapPickerRegion, setMapPickerRegion] = useState<MapRegion | null>(null);

  // ── Draw-region mode state ────────────────────────────────────────────────────
  const [drawRegionMode, setDrawRegionMode] = useState(false);
  const [pendingVertices, setPendingVertices] = useState<Array<{ x: number; y: number }>>([]);
  const [regionContextMenu, setRegionContextMenu] = useState<RegionContextMenuState>(null);
  const [deleteRegionTarget, setDeleteRegionTarget] = useState<MapRegion | null>(null);

  // ── Draw-route mode state (ROUTE-01, Plan 07) ─────────────────────────────────
  // pendingVertices is SHARED with draw-region — route draw is another branch in the
  // existing vertex pipeline (handleCanvasClick), NOT a new input paradigm.
  const [drawRouteMode, setDrawRouteMode] = useState(false);
  const [routeContextMenu, setRouteContextMenu] = useState<RouteContextMenuState>(null);
  const [deleteRouteTarget, setDeleteRouteTarget] = useState<MapRoute | null>(null);
  const [routeRelinkPickerOpen, setRouteRelinkPickerOpen] = useState(false);
  const [routeRelinkTarget, setRouteRelinkTarget] = useState<MapRoute | null>(null);
  const [renameRouteTarget, setRenameRouteTarget] = useState<MapRoute | null>(null);
  const [renameRouteDraft, setRenameRouteDraft] = useState('');
  const [routeColorTarget, setRouteColorTarget] = useState<MapRoute | null>(null);

  // ── Terrain paint state (43-04) ───────────────────────────────────────────────
  // armedTerrainTypeId !== null → paintTerrainMode active; pendingVertices SHARED with drawRegion
  const [armedTerrainTypeId, setArmedTerrainTypeId] = useState<string | null>(null);
  const [armedLayerId, setArmedLayerId] = useState<string | null>(null);
  const [terrainContextMenu, setTerrainContextMenu] = useState<TerrainContextMenuState>(null);
  const [reclassifySubmenuOpen, setReclassifySubmenuOpen] = useState(false);

  // ── Per-viewer layer visibility/opacity (localStorage, never server) ──────────
  // Key: `weltbon.mapview.${uid}.${mid}`; shape: Record<layerId, { visible, opacity }>
  const [layerViewerState, setLayerViewerState] = useState<
    Record<string, { visible: boolean; opacity: number }>
  >({});
  const [regionRelinkPickerOpen, setRegionRelinkPickerOpen] = useState(false);
  // Region whose entry link is being changed. Captured when the relink picker
  // opens because the context menu (its prior source) is dismissed immediately.
  const [regionRelinkTarget, setRegionRelinkTarget] = useState<MapRegion | null>(null);
  const [renameRegionTarget, setRenameRegionTarget] = useState<MapRegion | null>(null);
  const [renameRegionDraft, setRenameRegionDraft] = useState('');
  // Color picker state (for pins and regions)
  const [pinColorTarget, setPinColorTarget] = useState<MapPin | null>(null);
  const [regionColorTarget, setRegionColorTarget] = useState<MapRegion | null>(null);
  const [glyphPickerTarget, setGlyphPickerTarget] = useState<MapPin | null>(null);

  // ── Join pins with entries ────────────────────────────────────────────────────
  // The API returns bare map_pins rows (id, mapId, entryId, x, y, color, icon).
  // We join here to supply entryTitle/entryType/summary for MapCanvas pin display (D-07, D-09).
  //
  // SUMMARY SOURCE (D-07, memory list-endpoint-body-projection-false-green):
  // Auth mode: summary comes from the useEntries list cache (entry.summary — always present
  //   in the list projection). Fallback to pin.summary (e.g. for pins with no matching entry).
  // Share mode: entriesData is undefined (no useEntries join for share); enrichedPins
  //   falls back to map.pins, which already carry summary from the Plan 03 server projection
  //   (getPublicMap, entries INNER JOINed for is_public=true filter). No change needed here.
  //
  // DO NOT add body to this join — body is omitted from the entries list endpoint
  // (memory list-endpoint-body-projection-false-green) and would yield undefined in prod.
  // DO NOT re-key ['map',uid,mid] / ['maps',uid] / ['map-layers',uid] (memory react-query-key-change-blast-radius).
  const enrichedPins = useMemo<MapPin[]>(() => {
    if (!map?.pins) return [];
    if (!entriesData) return map.pins;
    const entryMap = new Map(entriesData.map((e) => [e.id, e]));
    return map.pins.map((pin) => {
      const entry = pin.entryId ? entryMap.get(pin.entryId) : undefined;
      return {
        ...pin,
        entryTitle: entry?.title ?? pin.entryTitle,
        entryType: entry?.entryType ?? pin.entryType,
        summary: entry?.summary ?? pin.summary,  // D-07: tooltip excerpt source (NEVER body)
      };
    });
  }, [map?.pins, entriesData]);

  // ── Regions from map payload ──────────────────────────────────────────────────
  // CR-01 fix: exclude terrain-area rows (those with terrainTypeId set) so they are
  // not double-rendered as grey RegionPolygons on top of the correct TerrainAreaPolygon.
  // Terrain-area rows are handled exclusively by the terrainAreas memo below.
  const regions = useMemo<MapRegion[]>(
    () => (map?.regions ?? []).filter((r) => !r.terrainTypeId),
    [map?.regions],
  );

  // ── Client-side terrain areas join (43-04) ────────────────────────────────────
  // Filter regions to those with a terrainTypeId, then enrich with color/layer from layers data.
  // This join means recoloring a terrain type propagates automatically on query invalidation.
  //
  // Phase 44 GEOSHARE-01 (D-44-03): In share mode, the share map detail already carries a
  // pre-enriched `terrainAreas` array (discriminated + joined server-side by getPublicMap).
  // Use it directly so no client-side join is required in share mode.
  const terrainAreas = useMemo<TerrainAreaRegion[]>(() => {
    // Share mode: use pre-enriched terrainAreas from the share map detail (D-44-03).
    if (isShare && map?.terrainAreas) {
      return map.terrainAreas;
    }
    if (!map?.regions || layers.length === 0) return [];
    // Auth mode: build a flat map: typeId → { terrainTypeColor, layerId, layerSortOrder }
    const typeMap = new Map<string, { terrainTypeColor: string; layerId: string; layerSortOrder: number }>();
    for (const layer of layers) {
      for (const type of layer.terrainTypes ?? []) {
        typeMap.set(type.id, {
          terrainTypeColor: type.color,
          layerId: layer.id,
          layerSortOrder: layer.sortOrder,
        });
      }
    }
    const result: TerrainAreaRegion[] = [];
    for (const region of map.regions) {
      if (!region.terrainTypeId) continue;
      const joined = typeMap.get(region.terrainTypeId);
      if (!joined) continue; // orphaned (type deleted) — skip
      result.push({
        ...region,
        terrainTypeId: region.terrainTypeId,
        terrainTypeColor: joined.terrainTypeColor,
        layerId: joined.layerId,
        layerSortOrder: joined.layerSortOrder,
      });
    }
    return result;
  }, [isShare, map?.terrainAreas, map?.regions, layers]);

  // ── Derive armed type name for paint banner ───────────────────────────────────
  const armedTypeName = useMemo(() => {
    if (!armedTerrainTypeId) return '';
    for (const layer of layers) {
      const found = (layer.terrainTypes ?? []).find((t) => t.id === armedTerrainTypeId);
      if (found) return found.name;
    }
    return '';
  }, [armedTerrainTypeId, layers]);

  // ── Universe entries for AddEntriesPicker ────────────────────────────────────
  const universeEntries = useMemo(
    () =>
      (entriesData ?? []).map((e) => ({
        id: e.id,
        title: e.title,
        entryType: e.entryType,
      })),
    [entriesData],
  );

  // ── Legend labels (parsed from map.legendLabels JSON) ────────────────────────
  const legendLabels = useMemo<Record<string, string> | null>(() => {
    if (!map?.legendLabels) return null;
    try {
      return JSON.parse(map.legendLabels) as Record<string, string>;
    } catch {
      return null;
    }
  }, [map?.legendLabels]);

  // ── Phase 52 SEARCH-01: client-side search match logic (D-06, D-07) ──────────────
  // Case-insensitive substring match over:
  //   - enrichedPins: linked-entry title only (D-06). Skip pins with no entryTitle.
  //   - regions: region name (D-06). Skip unnamed regions.
  //   - map.routes: route name/label (D-06). Skip unnamed routes.
  // Normalised 0..1 coords (nx, ny) are included for panZoomTo on select (D-05a).
  // D-06a: secret items are absent from the share payload (52-02) — they can never appear
  // in share-view search results; no separate search-side secret filtering needed.
  // DO NOT re-key any React Query cache key (memory: react-query-key-change-blast-radius).
  const searchResults = useMemo<SearchResult[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const results: SearchResult[] = [];

    // Pins — match linked-entry title; position = pin.x / pin.y (already normalized)
    for (const pin of enrichedPins) {
      if (!pin.entryTitle) continue;                           // no linked-entry title → skip (D-06)
      if (pin.entryTitle.toLowerCase().includes(q)) {
        results.push({ type: 'pin', id: pin.id, label: pin.entryTitle, nx: pin.x, ny: pin.y });
      }
      if (results.length >= 10) break;
    }

    // Regions — match region name; position = centroid of parsed point array
    for (const region of regions) {
      if (!region.name) continue;                              // unnamed → skip (D-06)
      if (region.name.toLowerCase().includes(q)) {
        let nx = 0.5;
        let ny = 0.5;
        try {
          const pts = JSON.parse(region.points) as Array<{ x: number; y: number }>;
          if (pts.length > 0) {
            nx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
            ny = pts.reduce((s, p) => s + p.y, 0) / pts.length;
          }
        } catch { /* malformed points → default to center */ }
        results.push({ type: 'region', id: region.id, label: region.name, nx, ny });
      }
      if (results.length >= 10) break;
    }

    // Routes — match route name/label; position = midpoint of middle segment
    for (const route of (map?.routes ?? [])) {
      if (!route.name) continue;                               // unnamed → skip (D-06)
      if (route.name.toLowerCase().includes(q)) {
        let nx = 0.5;
        let ny = 0.5;
        try {
          const pts = JSON.parse(route.points) as Array<{ x: number; y: number }>;
          if (pts.length >= 2) {
            const mid = Math.floor((pts.length - 1) / 2);
            nx = (pts[mid].x + pts[mid + 1].x) / 2;
            ny = (pts[mid].y + pts[mid + 1].y) / 2;
          } else if (pts.length === 1) {
            nx = pts[0].x;
            ny = pts[0].y;
          }
        } catch { /* malformed points → default to center */ }
        results.push({ type: 'route', id: route.id, label: route.name, nx, ny });
      }
      if (results.length >= 10) break;
    }

    return results.slice(0, 10);
  }, [searchQuery, enrichedPins, regions, map?.routes]);

  // ── Share-mode static layerViewerState (44-03 D-44-01) ────────────────────────
  // In share mode: build state statically from layers — all visible, each at its
  // own default_opacity. No localStorage, no toggles, no sliders. Recomputes when
  // layers data arrives (React Query populates it after the first fetch).
  const shareLayerViewerState = useMemo<Record<string, { visible: boolean; opacity: number }>>(() => {
    if (!isShare || layers.length === 0) return {};
    return Object.fromEntries(
      layers.map((l) => [l.id, { visible: true, opacity: l.defaultOpacity }]),
    );
  }, [isShare, layers]);

  // Apply the share static state when it is computed (layers arrive async).
  useEffect(() => {
    if (!isShare || layers.length === 0) return;
    setLayerViewerState(shareLayerViewerState);
  }, [isShare, shareLayerViewerState, layers]);

  // ── localStorage init-on-mount (43-04) ───────────────────────────────────────
  // Seed per-layer viewer state from localStorage; fall back to defaults on error (D-43-05, T-43-09).
  // Guarded off in share mode — visitors have no localStorage-backed preferences (D-44-01).
  useEffect(() => {
    if (isShare) return; // share mode uses shareLayerViewerState above
    if (!uid || !mid || layers.length === 0) return;
    const key = `weltbon.mapview.${uid}.${mid}`;
    try {
      const raw = localStorage.getItem(key);
      const stored = raw
        ? (JSON.parse(raw) as Record<string, { visible: boolean; opacity: number }>)
        : {};
      const init: Record<string, { visible: boolean; opacity: number }> = {};
      for (const layer of layers) {
        init[layer.id] = stored[layer.id] ?? { visible: true, opacity: layer.defaultOpacity };
      }
      setLayerViewerState(init);
    } catch {
      // Malformed JSON → fall back to all-layer defaults
      const init: Record<string, { visible: boolean; opacity: number }> = {};
      for (const layer of layers) {
        init[layer.id] = { visible: true, opacity: layer.defaultOpacity };
      }
      setLayerViewerState(init);
    }
  }, [isShare, uid, mid, layers]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── localStorage persist-on-change (43-04) ────────────────────────────────────
  // Write full state object to localStorage on any viewer state change (T-43-09, D-10).
  // Guarded off in share mode — no localStorage writes for visitors (D-44-01).
  useEffect(() => {
    if (isShare) return; // share mode is static; no persistence needed
    if (!uid || !mid || Object.keys(layerViewerState).length === 0) return;
    const key = `weltbon.mapview.${uid}.${mid}`;
    try {
      localStorage.setItem(key, JSON.stringify(layerViewerState));
    } catch {
      // Quota exceeded — ignore silently
    }
  }, [isShare, uid, mid, layerViewerState]);

  // ── Esc priority ladder (layered useEffects, mirrors DiagramEditor) ───────────

  // Priority 1: any picker open → close picker (entry or region-entry or rename).
  useEffect(() => {
    if (!entryPickerOpen && !relinkPickerOpen && !regionRelinkPickerOpen && !renameRegionTarget) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEntryPickerOpen(false);
        setPendingPinCoords(null);
        setRelinkPickerOpen(false);
        setRegionRelinkPickerOpen(false);
        setRegionRelinkTarget(null);
        setRenameRegionTarget(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [entryPickerOpen, relinkPickerOpen, regionRelinkPickerOpen, renameRegionTarget]);

  // Priority 2: drawRegionMode active + pending vertices → clear vertices.
  useEffect(() => {
    if (!drawRegionMode || pendingVertices.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingVertices([]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawRegionMode, pendingVertices]);

  // Priority 2b: Enter key to close region (≥3 vertices while in draw mode).
  useEffect(() => {
    if (!drawRegionMode || pendingVertices.length < 3) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCloseRegion();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawRegionMode, pendingVertices]);

  // Priority 2b-terrain (NEW 43-04): Enter key to close terrain area (≥3 vertices while painting).
  useEffect(() => {
    if (!armedTerrainTypeId || pendingVertices.length < 3) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCloseTerrainArea();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedTerrainTypeId, pendingVertices]);

  // Priority 2c (NEW 43-04): paintTerrainMode + pending vertices → clear vertices first (Esc).
  useEffect(() => {
    if (!armedTerrainTypeId || pendingVertices.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingVertices([]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [armedTerrainTypeId, pendingVertices]);

  // Priority 2d (NEW ROUTE-01): drawRouteMode + pending vertices → clear vertices first (Esc).
  useEffect(() => {
    if (!drawRouteMode || pendingVertices.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPendingVertices([]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawRouteMode, pendingVertices]);

  // Priority 2e (NEW ROUTE-01): Enter key to finish an open route (≥2 vertices while in route draw mode).
  // Mirror of the region Enter handler (Priority 2b) but with min-2-vertex guard.
  useEffect(() => {
    if (!drawRouteMode || pendingVertices.length < 2) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const verts = [...pendingVertices];
        setPendingVertices([]);
        void handleCloseRouteAsync(verts);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawRouteMode, pendingVertices]);

  // Priority 3: context menu open → close menu (pin or region or terrain or route).
  useEffect(() => {
    if (!contextMenu && !regionContextMenu && !terrainContextMenu && !routeContextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setSelectedPinId(null);
        setRegionContextMenu(null);
        setTerrainContextMenu(null);
        setReclassifySubmenuOpen(false);
        setRouteContextMenu(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [contextMenu, regionContextMenu, terrainContextMenu, routeContextMenu]);

  // Priority 4: addPinMode / drawRegionMode active (no picker/menu/vertices) → exit mode.
  useEffect(() => {
    if (!addPinMode || entryPickerOpen || contextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAddPinMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addPinMode, entryPickerOpen, contextMenu]);

  useEffect(() => {
    if (!drawRegionMode || pendingVertices.length > 0 || regionContextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawRegionMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawRegionMode, pendingVertices, regionContextMenu]);

  // Priority 4b (NEW 43-04): paintTerrainMode active (no pending vertices, no terrain menu) → disarm.
  useEffect(() => {
    if (!armedTerrainTypeId || pendingVertices.length > 0 || terrainContextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setArmedTerrainTypeId(null);
        setArmedLayerId(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [armedTerrainTypeId, pendingVertices, terrainContextMenu]);

  // Priority 4c (NEW ROUTE-01): drawRouteMode active (no pending vertices, no route menu) → exit mode.
  useEffect(() => {
    if (!drawRouteMode || pendingVertices.length > 0 || routeContextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawRouteMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [drawRouteMode, pendingVertices, routeContextMenu]);

  // ── Draw-region close helper ─────────────────────────────────────────────────

  const handleCloseRegion = useCallback(async () => {
    if (pendingVertices.length < 3) return;
    const pts = [...pendingVertices];
    setPendingVertices([]);
    // Don't exit drawRegionMode so user can draw multiple regions.
    try {
      await createRegion.mutateAsync({
        name: '',
        points: JSON.stringify(pts),
        entryId: null,
        color: null,
      });
    } catch {
      setToast({ message: COPY.regionSaveError, variant: 'error' });
    }
  }, [createRegion, pendingVertices]);

  // ── Terrain paint close helper (43-04) ───────────────────────────────────────
  // Mirrors handleCloseRegion but passes terrainTypeId; swatch stays armed for multi-paint (D-43-01).
  const handleCloseTerrainArea = useCallback(async () => {
    if (pendingVertices.length < 3) return;
    const pts = [...pendingVertices];
    setPendingVertices([]);
    // Do NOT clear armedTerrainTypeId — multi-paint stays armed.
    try {
      await createRegion.mutateAsync({
        name: '',
        points: JSON.stringify(pts),
        entryId: null,
        color: null,
        terrainTypeId: armedTerrainTypeId,
      });
    } catch {
      setToast({ message: COPY.terrainSaveError, variant: 'error' });
    }
  }, [createRegion, pendingVertices, armedTerrainTypeId]);

  // Async version that takes vertex snapshot (avoids stale closure in setState callback).
  const handleCloseTerrainAreaAsync = useCallback(async (verts: Array<{ x: number; y: number }>) => {
    if (verts.length < 3) return;
    try {
      await createRegion.mutateAsync({
        name: '',
        points: JSON.stringify(verts),
        entryId: null,
        color: null,
        terrainTypeId: armedTerrainTypeId,
      });
    } catch {
      setToast({ message: COPY.terrainSaveError, variant: 'error' });
    }
  }, [createRegion, armedTerrainTypeId]);

  // ── Add-pin flow handlers ────────────────────────────────────────────────────

  /**
   * Called by MapCanvas when user clicks the canvas in addPinMode or drawRegionMode.
   * In drawRegionMode: append vertex; snap-close if on first vertex (≥3 verts).
   * In addPinMode: store pending coords and open entry picker.
   */
  const handleCanvasClick = useCallback((nx: number, ny: number) => {
    // NEW (43-04): paintTerrainMode branch — mirrors drawRegionMode vertex-append logic.
    // Route draw branch (ROUTE-01, Plan 07): append vertex; finish via Enter or double-click
    // (NOT snap-to-first — routes are open polylines). Checked before drawRegionMode so the
    // route mode takes priority when both might be set (mutual exclusivity is enforced at arm-time).
    if (drawRouteMode) {
      setPendingVertices((verts) => [...verts, { x: nx, y: ny }]);
      return;
    }
    if (armedTerrainTypeId) {
      setPendingVertices((verts) => {
        if (verts.length >= 3) {
          const fv = verts[0];
          const dx = Math.abs(nx - fv.x);
          const dy = Math.abs(ny - fv.y);
          if (dx < 0.025 && dy < 0.025) {
            setTimeout(() => handleCloseTerrainAreaAsync([...verts]), 0);
            return [];
          }
        }
        return [...verts, { x: nx, y: ny }];
      });
      return;
    }
    if (drawRegionMode) {
      // Check if the click is near the first vertex — close polygon (snap).
      setPendingVertices((verts) => {
        if (verts.length >= 3) {
          const fv = verts[0];
          const dx = Math.abs(nx - fv.x);
          const dy = Math.abs(ny - fv.y);
          // Snap threshold: 0.025 of image fraction (loose in normalized space).
          if (dx < 0.025 && dy < 0.025) {
            // Trigger close asynchronously to avoid setState-in-setState.
            setTimeout(() => handleCloseRegionAsync([...verts]), 0);
            return [];
          }
        }
        return [...verts, { x: nx, y: ny }];
      });
      return;
    }
    // addPinMode:
    setPendingPinCoords({ x: nx, y: ny });
    setEntryPickerOpen(true);
  }, [drawRouteMode, armedTerrainTypeId, drawRegionMode, handleCloseTerrainAreaAsync, handleCloseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Async version that takes a snapshot of vertices (avoids stale closure in setState callback).
  const handleCloseRegionAsync = useCallback(async (verts: Array<{ x: number; y: number }>) => {
    if (verts.length < 3) return;
    try {
      await createRegion.mutateAsync({
        name: '',
        points: JSON.stringify(verts),
        entryId: null,
        color: null,
      });
    } catch {
      setToast({ message: COPY.regionSaveError, variant: 'error' });
    }
  }, [createRegion]);

  // ── Route draw close helper (ROUTE-01, Plan 07) ──────────────────────────────
  // Mirror of handleCloseRegionAsync but with min 2 vertices (routes are OPEN polylines,
  // not closed polygons; min-3 rule does NOT apply). Does not clear drawRouteMode so the
  // user can draw multiple routes without re-arming.
  const handleCloseRouteAsync = useCallback(async (verts: Array<{ x: number; y: number }>) => {
    if (verts.length < 2) return;
    try {
      await createRoute.mutateAsync({
        name: '',
        points: JSON.stringify(verts),
        entryId: null,
        color: null,
      });
    } catch {
      setToast({ message: COPY.routeSaveError, variant: 'error' });
    }
  }, [createRoute]);

  /**
   * Called when user selects an entry from the picker.
   * Calls useAddPin with the pending coords + chosen entryId.
   * Picker closes but addPinMode stays active for multiple placements.
   */
  const handleEntryAdd = useCallback(
    async (entryId: string) => {
      if (!pendingPinCoords) return;
      setEntryPickerOpen(false);
      setPendingPinCoords(null);
      try {
        await addPin.mutateAsync({
          entryId,
          x: pendingPinCoords.x,
          y: pendingPinCoords.y,
        });
      } catch {
        setToast({ message: COPY.pinSaveError, variant: 'error' });
      }
    },
    [addPin, pendingPinCoords],
  );

  // ── Drag-reposition handler ──────────────────────────────────────────────────

  const handlePinDragEnd = useCallback(
    async (pinId: string, nx: number, ny: number) => {
      try {
        await movePin.mutateAsync({ pinId, x: nx, y: ny });
      } catch {
        setToast({ message: COPY.pinSaveError, variant: 'error' });
      }
    },
    [movePin],
  );

  // ── Pin context menu handlers ────────────────────────────────────────────────

  const handlePinContextMenu = useCallback(
    (pin: MapPin, clientX: number, clientY: number) => {
      setContextMenu({ pin, clientX, clientY });
      setSelectedPinId(pin.id);
    },
    [],
  );

  const handleContextMenuDelete = () => {
    if (!contextMenu) return;
    setDeletePinTarget(contextMenu.pin);
    setContextMenu(null);
  };

  const handleContextMenuRelink = () => {
    if (!contextMenu) return;
    setRelinkPickerOpen(true);
    setContextMenu(null);
  };

  const handleContextMenuPinColor = () => {
    if (!contextMenu) return;
    setPinColorTarget(contextMenu.pin);
    setContextMenu(null);
  };

  const handleContextMenuPinGlyph = () => {
    if (!contextMenu) return;
    setGlyphPickerTarget(contextMenu.pin);
    setContextMenu(null);
  };

  // Phase 52 SECRET-01: toggle secret on pin from context menu (D-01).
  // Only shown to owner (gated !isShare at render time).
  const handleContextMenuTogglePinSecret = async () => {
    if (!contextMenu) return;
    const { pin } = contextMenu;
    setContextMenu(null);
    try {
      await togglePinSecret.mutateAsync({ pinId: pin.id, secret: !pin.secret });
    } catch {
      setToast({ message: COPY.pinSaveError, variant: 'error' });
    }
  };

  // Phase 53 NEST-01 D-01: open map picker from pin context menu.
  // Captures current pin, closes context menu, opens picker.
  const handleContextMenuLinkMap = () => {
    if (!contextMenu) return;
    setMapPickerPin(contextMenu.pin);
    setMapPickerRegion(null);
    setMapPickerOpen(true);
    setContextMenu(null);
    setSelectedPinId(null);
  };

  // Phase 53 NEST-01 D-01: directly unlink target map from pin context menu (no picker).
  // Neutral action — no ConfirmDialog (UI-SPEC Color note: unlinking is non-destructive).
  const handleContextMenuUnlinkMapPin = async () => {
    if (!contextMenu) return;
    const { pin } = contextMenu;
    setContextMenu(null);
    setSelectedPinId(null);
    try {
      await setPinTargetMap.mutateAsync({ pinId: pin.id, targetMapId: null });
    } catch {
      setToast({ message: COPY.linkMapError, variant: 'error' });
    }
  };

  const handleDeletePinConfirm = async () => {
    if (!deletePinTarget) return;
    try {
      await deletePin.mutateAsync(deletePinTarget.id);
    } catch {
      setToast({ message: COPY.pinDeleteError, variant: 'error' });
    }
    setDeletePinTarget(null);
    setSelectedPinId(null);
  };

  const handleRelinkEntry = async (entryId: string) => {
    if (!selectedPinId) return;
    setRelinkPickerOpen(false);
    try {
      await relinkPin.mutateAsync({ pinId: selectedPinId, entryId });
    } catch {
      setToast({ message: COPY.pinSaveError, variant: 'error' });
    }
    setSelectedPinId(null);
  };

  // ── Region context menu handlers ─────────────────────────────────────────────

  const handleRegionClick = useCallback((region: MapRegion) => {
    // Phase 53 NEST-01 D-02: map-open wins — check targetMapId FIRST.
    // Passes origin via router state so MapBreadcrumb can render on the target map (D-03).
    if (region.targetMapId) {
      const to = shareToken
        ? `/share/${shareToken}/maps/${region.targetMapId}`
        : `/universes/${uid}/maps/${region.targetMapId}`;
      navigate(to, { state: { from: { name: map?.name ?? '', id: mid } } });
      return;
    }
    // Left-click navigates to linked entry (D-08-click); inert if no entryId.
    // In share mode stay within /share/:token to avoid uid leaks (T-40-14).
    if (region.entryId) {
      if (shareToken) {
        navigate(`/share/${shareToken}/entries/${region.entryId}`);
      } else {
        navigate(`/universes/${uid}/entries/${region.entryId}`);
      }
    }
  }, [navigate, shareToken, uid, mid, map?.name]);

  // Phase 53 NEST-01 D-02: pin click-to-open handler (passed as MapCanvas onOpenMap).
  // Share-token-aware route; passes origin via router state for breadcrumb (D-03).
  // Works identically in editor and share (MapCanvas calls onOpenMap for both).
  const handleOpenMap = useCallback((targetMapId: string) => {
    const to = shareToken
      ? `/share/${shareToken}/maps/${targetMapId}`
      : `/universes/${uid}/maps/${targetMapId}`;
    navigate(to, { state: { from: { name: map?.name ?? '', id: mid } } });
  }, [navigate, shareToken, uid, mid, map?.name]);

  const handleRegionContextMenu = useCallback(
    (region: MapRegion, clientX: number, clientY: number) => {
      setRegionContextMenu({ region, clientX, clientY });
    },
    [],
  );

  const handleRegionContextMenuDelete = () => {
    if (!regionContextMenu) return;
    setDeleteRegionTarget(regionContextMenu.region);
    setRegionContextMenu(null);
  };

  const handleRegionContextMenuRelink = () => {
    if (!regionContextMenu) return;
    setRegionRelinkTarget(regionContextMenu.region);
    setRegionRelinkPickerOpen(true);
    setRegionContextMenu(null);
  };

  const handleRegionContextMenuRename = () => {
    if (!regionContextMenu) return;
    setRenameRegionTarget(regionContextMenu.region);
    setRenameRegionDraft(regionContextMenu.region.name);
    setRegionContextMenu(null);
  };

  const handleRegionContextMenuColor = () => {
    if (!regionContextMenu) return;
    setRegionColorTarget(regionContextMenu.region);
    setRegionContextMenu(null);
  };

  // Phase 52 SECRET-01: toggle secret on region from context menu (D-01).
  // Only shown to owner (gated !isShare at render time).
  const handleRegionContextMenuToggleSecret = async () => {
    if (!regionContextMenu) return;
    const { region } = regionContextMenu;
    setRegionContextMenu(null);
    try {
      await toggleRegionSecret.mutateAsync({ regionId: region.id, secret: !region.secret });
    } catch {
      setToast({ message: COPY.regionSaveError, variant: 'error' });
    }
  };

  // Phase 53 NEST-01 D-01: open map picker from region context menu.
  const handleRegionContextMenuLinkMap = () => {
    if (!regionContextMenu) return;
    setMapPickerRegion(regionContextMenu.region);
    setMapPickerPin(null);
    setMapPickerOpen(true);
    setRegionContextMenu(null);
  };

  // Phase 53 NEST-01 D-01: directly unlink target map from region context menu (no picker).
  const handleRegionContextMenuUnlinkMap = async () => {
    if (!regionContextMenu) return;
    const { region } = regionContextMenu;
    setRegionContextMenu(null);
    try {
      await setRegionTargetMap.mutateAsync({ regionId: region.id, targetMapId: null });
    } catch {
      setToast({ message: COPY.linkMapError, variant: 'error' });
    }
  };

  const handleDeleteRegionConfirm = async () => {
    if (!deleteRegionTarget) return;
    try {
      await deleteRegion.mutateAsync(deleteRegionTarget.id);
    } catch {
      setToast({ message: COPY.regionDeleteError, variant: 'error' });
    }
    setDeleteRegionTarget(null);
  };

  const handleRegionRelinkEntry = async (entryId: string) => {
    const region = regionRelinkTarget;
    setRegionRelinkPickerOpen(false);
    setRegionRelinkTarget(null);
    if (!region) return;
    try {
      await updateRegion.mutateAsync({ regionId: region.id, entryId });
    } catch {
      setToast({ message: COPY.regionSaveError, variant: 'error' });
    }
  };

  const handleRegionRenameConfirm = async () => {
    if (!renameRegionTarget) return;
    try {
      await updateRegion.mutateAsync({
        regionId: renameRegionTarget.id,
        name: renameRegionDraft,
      });
    } catch {
      setToast({ message: COPY.regionSaveError, variant: 'error' });
    }
    setRenameRegionTarget(null);
  };

  // Phase 53 NEST-01 D-01: map picker selection handler (called by MapPickerModal onSelect).
  // Captures mapPickerPin/mapPickerRegion from the closure at call time — state is stable
  // because onClose (which clears the state) runs AFTER onSelect in the picker.
  const handleSelectTargetMap = async (mapId: string) => {
    try {
      if (mapPickerPin) {
        await setPinTargetMap.mutateAsync({ pinId: mapPickerPin.id, targetMapId: mapId });
      } else if (mapPickerRegion) {
        await setRegionTargetMap.mutateAsync({ regionId: mapPickerRegion.id, targetMapId: mapId });
      }
    } catch {
      setToast({ message: COPY.linkMapError, variant: 'error' });
    }
  };

  // Phase 53 NEST-01 D-01: map picker unlink handler (called by MapPickerModal onUnlink).
  const handleUnlinkTargetMap = async () => {
    try {
      if (mapPickerPin) {
        await setPinTargetMap.mutateAsync({ pinId: mapPickerPin.id, targetMapId: null });
      } else if (mapPickerRegion) {
        await setRegionTargetMap.mutateAsync({ regionId: mapPickerRegion.id, targetMapId: null });
      }
    } catch {
      setToast({ message: COPY.linkMapError, variant: 'error' });
    }
  };

  // ── Terrain area context menu handlers (43-04) ───────────────────────────────

  const handleTerrainAreaContextMenu = useCallback(
    (region: TerrainAreaRegion, clientX: number, clientY: number) => {
      setTerrainContextMenu({ region, clientX, clientY });
      setReclassifySubmenuOpen(false);
    },
    [],
  );

  const handleTerrainContextMenuDelete = async () => {
    if (!terrainContextMenu) return;
    const region = terrainContextMenu.region;
    setTerrainContextMenu(null);
    setReclassifySubmenuOpen(false);
    // Instant delete — no ConfirmDialog (D-43-02)
    try {
      await deleteRegion.mutateAsync(region.id);
    } catch {
      setToast({ message: COPY.terrainDeleteError, variant: 'error' });
    }
  };

  const handleTerrainReclassify = async (newTypeId: string) => {
    if (!terrainContextMenu) return;
    const regionId = terrainContextMenu.region.id;
    setTerrainContextMenu(null);
    setReclassifySubmenuOpen(false);
    try {
      await updateRegion.mutateAsync({ regionId, terrainTypeId: newTypeId });
    } catch {
      setToast({ message: COPY.terrainReclassifyError, variant: 'error' });
    }
  };

  // ── Arm terrain type handler (43-04) ─────────────────────────────────────────

  const handleArmTerrainType = useCallback(
    (typeId: string | null, layerId: string) => {
      // Exit other modes (mode exclusivity)
      setAddPinMode(false);
      setDrawRegionMode(false);
      setPendingVertices([]);
      if (typeId === armedTerrainTypeId) {
        // Clicking the same armed swatch while no pending vertices → disarm
        setArmedTerrainTypeId(null);
        setArmedLayerId(null);
      } else {
        setArmedTerrainTypeId(typeId);
        setArmedLayerId(layerId);
        // D-43-07: auto-reveal the layer if hidden
        if (typeId) {
          setLayerViewerState((prev) => {
            const cur = prev[layerId];
            if (!cur?.visible) {
              const ownerLayer = layers.find((l) => l.id === layerId);
              return {
                ...prev,
                [layerId]: {
                  visible: true,
                  opacity: cur?.opacity ?? ownerLayer?.defaultOpacity ?? 0.6,
                },
              };
            }
            return prev;
          });
        }
      }
    },
    [armedTerrainTypeId, layers],
  );

  // ── Route left-click navigate (ROUTE-02, Plan 07) ────────────────────────────
  // Share-aware: mirror handleRegionClick (731-739). Navigate within /share/:token in share
  // mode to avoid uid leaks (T-51-14). Inert when route.entryId is null.
  const handleRouteClick = useCallback((route: MapRoute) => {
    if (route.entryId) {
      if (shareToken) {
        navigate(`/share/${shareToken}/entries/${route.entryId}`);
      } else {
        navigate(`/universes/${uid}/entries/${route.entryId}`);
      }
    }
  }, [navigate, shareToken, uid]);

  // ── Route context menu handlers (ROUTE-02, Plan 07) ──────────────────────────
  // Mirror the region context menu set (741-807): clone handlers swapping region→route,
  // adding the route-only restyle controls (lineStyle/width/showArrow, D-06).

  const handleRouteContextMenu = useCallback(
    (route: MapRoute, clientX: number, clientY: number) => {
      setRouteContextMenu({ route, clientX, clientY });
    },
    [],
  );

  const handleRouteContextMenuDelete = () => {
    if (!routeContextMenu) return;
    setDeleteRouteTarget(routeContextMenu.route);
    setRouteContextMenu(null);
  };

  const handleRouteContextMenuRelink = () => {
    if (!routeContextMenu) return;
    setRouteRelinkTarget(routeContextMenu.route);
    setRouteRelinkPickerOpen(true);
    setRouteContextMenu(null);
  };

  const handleRouteContextMenuRename = () => {
    if (!routeContextMenu) return;
    setRenameRouteTarget(routeContextMenu.route);
    setRenameRouteDraft(routeContextMenu.route.name);
    setRouteContextMenu(null);
  };

  const handleRouteContextMenuColor = () => {
    if (!routeContextMenu) return;
    setRouteColorTarget(routeContextMenu.route);
    setRouteContextMenu(null);
  };

  // Route-only restyle: line-style toggle (solid↔dashed), width preset, arrow toggle (D-06).
  const handleRouteContextMenuLineStyle = async () => {
    if (!routeContextMenu) return;
    const { route } = routeContextMenu;
    setRouteContextMenu(null);
    const newStyle: 'solid' | 'dashed' = route.lineStyle === 'dashed' ? 'solid' : 'dashed';
    try {
      await updateRoute.mutateAsync({ routeId: route.id, lineStyle: newStyle });
    } catch {
      setToast({ message: COPY.routeSaveError, variant: 'error' });
    }
  };

  const handleRouteContextMenuWidth = async (width: number) => {
    if (!routeContextMenu) return;
    const { route } = routeContextMenu;
    setRouteContextMenu(null);
    try {
      await updateRoute.mutateAsync({ routeId: route.id, width });
    } catch {
      setToast({ message: COPY.routeSaveError, variant: 'error' });
    }
  };

  const handleRouteContextMenuArrow = async () => {
    if (!routeContextMenu) return;
    const { route } = routeContextMenu;
    setRouteContextMenu(null);
    try {
      await updateRoute.mutateAsync({ routeId: route.id, showArrow: !route.showArrow });
    } catch {
      setToast({ message: COPY.routeSaveError, variant: 'error' });
    }
  };

  // Phase 52 SECRET-01: toggle secret on route from context menu (D-01).
  // Only shown to owner (gated !isShare at render time).
  const handleRouteContextMenuToggleSecret = async () => {
    if (!routeContextMenu) return;
    const { route } = routeContextMenu;
    setRouteContextMenu(null);
    try {
      await toggleRouteSecret.mutateAsync({ routeId: route.id, secret: !route.secret });
    } catch {
      setToast({ message: COPY.routeSaveError, variant: 'error' });
    }
  };

  const handleDeleteRouteConfirm = async () => {
    if (!deleteRouteTarget) return;
    try {
      await deleteRoute.mutateAsync(deleteRouteTarget.id);
    } catch {
      setToast({ message: COPY.routeDeleteError, variant: 'error' });
    }
    setDeleteRouteTarget(null);
  };

  const handleRouteRelinkEntry = async (entryId: string) => {
    const route = routeRelinkTarget;
    setRouteRelinkPickerOpen(false);
    setRouteRelinkTarget(null);
    if (!route) return;
    try {
      await updateRoute.mutateAsync({ routeId: route.id, entryId });
    } catch {
      setToast({ message: COPY.routeSaveError, variant: 'error' });
    }
  };

  const handleRouteRenameConfirm = async () => {
    if (!renameRouteTarget) return;
    try {
      await updateRoute.mutateAsync({
        routeId: renameRouteTarget.id,
        name: renameRouteDraft,
      });
    } catch {
      setToast({ message: COPY.routeSaveError, variant: 'error' });
    }
    setRenameRouteTarget(null);
  };

  const handleRouteColorSelect = async (color: string) => {
    if (!routeColorTarget) return;
    const route = routeColorTarget;
    setRouteColorTarget(null);
    try {
      await updateRoute.mutateAsync({ routeId: route.id, color });
    } catch {
      setToast({ message: COPY.routeSaveError, variant: 'error' });
    }
  };

  // dblclick finisher for route draw (Plan 07 ROUTE-01).
  // Uses functional setState to read the latest vertices snapshot — avoids stale closure.
  // Removes the last vertex (the duplicate from the dblclick's second single-click) before closing.
  const handleCanvasDblClick = useCallback(() => {
    if (!drawRouteMode) return;
    setPendingVertices((verts) => {
      // Trim the duplicate dblclick vertex (2nd click of dblclick adds an extra point).
      const trimmed = verts.length > 1 ? verts.slice(0, -1) : verts;
      if (trimmed.length >= 2) {
        setTimeout(() => handleCloseRouteAsync(trimmed), 0);
      }
      return []; // always clear pending vertices on dblclick finish
    });
  }, [drawRouteMode, handleCloseRouteAsync]);

  // ── onLayerViewerStateChange helper (43-04) ────────────────────────────────────
  const handleLayerViewerStateChange = useCallback(
    (layerId: string, patch: { visible?: boolean; opacity?: number }) => {
      setLayerViewerState((prev) => ({
        ...prev,
        [layerId]: { ...prev[layerId], ...patch },
      }));
    },
    [],
  );

  // ── Color / glyph picker handlers ────────────────────────────────────────────

  const handlePinColorSelect = async (color: string) => {
    if (!pinColorTarget) return;
    const pin = pinColorTarget;
    setPinColorTarget(null);
    try {
      await updatePinStyle.mutateAsync({ pinId: pin.id, color });
    } catch {
      setToast({ message: COPY.pinSaveError, variant: 'error' });
    }
  };

  const handlePinGlyphSelect = async (glyph: string | null) => {
    if (!glyphPickerTarget) return;
    const pin = glyphPickerTarget;
    setGlyphPickerTarget(null);
    try {
      await updatePinStyle.mutateAsync({ pinId: pin.id, icon: glyph });
    } catch {
      setToast({ message: COPY.pinSaveError, variant: 'error' });
    }
  };

  const handleRegionColorSelect = async (color: string) => {
    if (!regionColorTarget) return;
    const region = regionColorTarget;
    setRegionColorTarget(null);
    try {
      await updateRegion.mutateAsync({ regionId: region.id, color });
    } catch {
      setToast({ message: COPY.regionSaveError, variant: 'error' });
    }
  };

  // ── LayersPanel color picker handler (onRequestColorPick wiring) ─────────────
  // The LayersPanel surfaces an optional onRequestColorPick callback so MapEditor
  // can open the shared MAP_COLOR_PALETTE picker for terrain-type swatch changes.
  const handleRequestColorPick = useCallback(
    (currentColor: string, onPick: (hex: string) => void) => {
      setLayersColorPickerCurrent(currentColor);
      setLayersColorPickerCallback(() => onPick);
      setLayersColorPickerOpen(true);
    },
    [],
  );

  // ── Legend rename handler ────────────────────────────────────────────────────

  const handleLegendRenameLabel = useCallback(
    async (key: string, value: string) => {
      const current = legendLabels ?? {};
      const updated = { ...current, [key]: value };
      try {
        await updateMap.mutateAsync({ legendLabels: JSON.stringify(updated) });
      } catch {
        setToast({ message: "Couldn't save legend label. Try again.", variant: 'error' });
      }
    },
    [legendLabels, updateMap],
  );

  // ── Change image handler ─────────────────────────────────────────────────────

  const handleChangeImageSelect = async (assetId: string) => {
    setChangeImageOpen(false);
    try {
      await updateMap.mutateAsync({ imageAssetId: assetId });
    } catch {
      setToast({ message: COPY.pinSaveError, variant: 'error' });
    }
  };

  // ── Click-away to close context menus ────────────────────────────────────────
  useEffect(() => {
    if (!contextMenu && !regionContextMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.getElementById('map-context-menu');
      const regionMenu = document.getElementById('map-region-context-menu');
      if (menu && !menu.contains(e.target as Node)) {
        setContextMenu(null);
        setSelectedPinId(null);
      }
      if (regionMenu && !regionMenu.contains(e.target as Node)) {
        setRegionContextMenu(null);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [contextMenu, regionContextMenu]);

  // ── Click-away to close terrain context menu (43-04) ─────────────────────────
  useEffect(() => {
    if (!terrainContextMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.getElementById('map-terrain-context-menu');
      if (menu && !menu.contains(e.target as Node)) {
        setTerrainContextMenu(null);
        setReclassifySubmenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [terrainContextMenu]);

  // ── Click-away to close route context menu (ROUTE-02, Plan 07) ───────────────
  useEffect(() => {
    if (!routeContextMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.getElementById('map-route-context-menu');
      if (menu && !menu.contains(e.target as Node)) {
        setRouteContextMenu(null);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [routeContextMenu]);

  // ── Phase 52 SEARCH-01: click-away to close search dropdown ──────────────────
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const handler = (e: MouseEvent) => {
      const dropdown = document.getElementById('map-search-dropdown');
      const input = searchInputRef.current;
      if (
        dropdown && !dropdown.contains(e.target as Node) &&
        input && !input.contains(e.target as Node)
      ) {
        setSearchQuery('');
        setSelectedResultIndex(-1);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [searchQuery]);

  // Reset arrow-key selection when search results change (new query typed).
  useEffect(() => {
    setSelectedResultIndex(-1);
  }, [searchResults]);

  // ── Phase 52 SEARCH-01: `/` shortcut — focus the search input (D-04) ─────────
  // No-op when focus is already in an INPUT or TEXTAREA (D-04 guard).
  // Mirror of existing keydown effect ladder (lines 456–607).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ── Phase 52 SEARCH-01: select handler — panZoomTo + highlight ───────────────
  // Clears the query, pans/zooms to the item, sets a temporary highlight, then
  // clears it after the 1.5s pulse animation + buffer.
  // CRITICAL: no d3 datum handler — imperative ref call only.
  const handleSearchResultSelect = useCallback((result: SearchResult) => {
    setSearchQuery('');
    setSelectedResultIndex(-1);
    canvasRef.current?.panZoomTo(result.nx, result.ny);
    setHighlightedItemId(result.id);
    setTimeout(() => setHighlightedItemId(null), 2000);
  }, []);

  // ── Phase 52 SEARCH-01: Arrow/Enter keyboard navigation in the dropdown ───────
  // Attached to the window when the search dropdown is visible (searchQuery non-empty
  // + results exist). Checks `document.activeElement === searchInputRef.current` so
  // it only fires when the search input is focused.
  useEffect(() => {
    if (!searchQuery.trim() || searchResults.length === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (document.activeElement !== searchInputRef.current) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedResultIndex((i) => Math.min(i + 1, searchResults.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedResultIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        if (selectedResultIndex >= 0 && selectedResultIndex < searchResults.length) {
          e.preventDefault();
          handleSearchResultSelect(searchResults[selectedResultIndex]);
        }
      } else if (e.key === 'Escape') {
        setSearchQuery('');
        setSelectedResultIndex(-1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchQuery, searchResults, selectedResultIndex, handleSearchResultSelect]);

  // ── Render ────────────────────────────────────────────────────────────────────

  if (isLoading) {
    return <p className="p-6 text-sm text-neutral-500">{COPY.loading}</p>;
  }

  if (isError || !map) {
    return <p className="p-6 text-sm text-red-500">{COPY.error}</p>;
  }

  // The currently-selected pin's enriched record (for delete confirm title).
  const deletePinTitle =
    enrichedPins.find((p) => p.id === deletePinTarget?.id)?.entryTitle ?? 'this entry';

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Floating toolbar overlay — Phase 52 SEARCH-01: now renders in BOTH editor and share mode
          so the search input is available to share visitors (D-04 + D-06a).
          Mutation buttons (Add pin, Draw region, Change image, etc.) only appear when their
          callbacks are provided — they are omitted in share mode. The search input always
          appears (when onSearchQueryChange is provided). */}
      <MapToolbar
        mapName={map.name}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchInputRef={searchInputRef}
        hasBreadcrumb={!!fromOrigin}
        {...(!isShare ? {
          addPinMode,
          onToggleAddPinMode: () => {
            setAddPinMode((v) => !v);
            if (drawRegionMode) setDrawRegionMode(false);
            if (drawRouteMode) { setDrawRouteMode(false); setPendingVertices([]); }
            // Exit terrain paint mode (mode exclusivity)
            if (armedTerrainTypeId) {
              setArmedTerrainTypeId(null);
              setArmedLayerId(null);
            }
          },
          drawRegionMode,
          onToggleDrawRegionMode: () => {
            setDrawRegionMode((v) => !v);
            if (addPinMode) setAddPinMode(false);
            if (drawRouteMode) { setDrawRouteMode(false); setPendingVertices([]); }
            if (!drawRegionMode) setPendingVertices([]);
            // Exit terrain paint mode (mode exclusivity)
            if (armedTerrainTypeId) {
              setArmedTerrainTypeId(null);
              setArmedLayerId(null);
            }
          },
          drawRouteMode,
          onToggleDrawRouteMode: () => {
            setDrawRouteMode((v) => !v);
            if (addPinMode) setAddPinMode(false);
            if (drawRegionMode) { setDrawRegionMode(false); }
            if (!drawRouteMode) setPendingVertices([]);
            if (armedTerrainTypeId) {
              setArmedTerrainTypeId(null);
              setArmedLayerId(null);
            }
          },
          onChangeImage: () => setChangeImageOpen(true),
          legendVisible,
          onToggleLegend: () => setLegendVisible((v) => !v),
          layersPanelVisible,
          onToggleLayersPanel: () => setLayersPanelVisible((v) => !v),
        } : {})}
      />

      {/* Phase 52 SEARCH-01: live search results dropdown (D-05).
          Positioned below the toolbar (top-14 = 56px, toolbar is top-4 ~40px tall).
          z-50 matches context menus. Shows when the search query is non-empty.
          Each row: type badge + label + item-type tag (D-05).
          Keyboard: ArrowUp/Down selects row; Enter confirms; Escape clears.
          All elements React-rendered — no d3 datum handlers
          (memory: timeline-pins-react-rendered-no-d3-datum). */}
      {searchQuery.trim() && (
        <div
          id="map-search-dropdown"
          role="listbox"
          aria-label="Search results"
          className="absolute left-4 top-14 z-50 min-w-[260px] max-w-[320px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg overflow-hidden"
        >
          {searchResults.length === 0 ? (
            /* D-05: explicit empty/no-match state */
            <div className="px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400 italic">
              No matches
            </div>
          ) : (
            searchResults.map((result, idx) => (
              <button
                key={result.id}
                type="button"
                role="option"
                aria-selected={idx === selectedResultIndex}
                onClick={() => handleSearchResultSelect(result)}
                onMouseEnter={() => setSelectedResultIndex(idx)}
                className={[
                  'w-full text-left text-sm px-3 py-2 flex items-center gap-2',
                  idx === selectedResultIndex
                    ? 'bg-[color:var(--color-accent-soft,#eff6ff)] dark:bg-neutral-800'
                    : 'hover:bg-neutral-50 dark:hover:bg-neutral-800',
                ].join(' ')}
              >
                {/* Type badge (D-05) — colored pill, no emoji */}
                <span
                  className={[
                    'flex-shrink-0 text-xs font-semibold px-1.5 py-0.5 rounded-full',
                    result.type === 'pin'
                      ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                      : result.type === 'region'
                      ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                      : 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {result.type === 'pin' ? 'Pin' : result.type === 'region' ? 'Region' : 'Route'}
                </span>
                {/* Label — truncated to keep dropdown compact */}
                <span className="flex-1 truncate text-neutral-900 dark:text-neutral-100">
                  {result.label}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {/* Share-mode legend toggle button — top-right, independent of toolbar position */}
      {isShare && (
        <div className="absolute top-3 right-3 z-10">
          <button
            type="button"
            onClick={() => setLegendVisible((v) => !v)}
            className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-sm px-3 py-1.5 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            aria-label="Toggle legend"
          >
            Legend
          </button>
        </div>
      )}

      {/* ── Single hint banner (BUG-2 fix) ─────────────────────────────────────
          Previously four separate <div>s at the same absolute position could stack
          when two modes were simultaneously active (e.g. addPinMode + drawRouteMode),
          producing garbled overlapping text. Fix: compute ONE banner string and render
          AT MOST ONE element. Priority order mirrors the toolbar mutual-exclusion logic
          (route > region > terrain > addPin). */}
      {!isShare && (() => {
        // Compute the single active banner text (null → no banner rendered).
        const bannerText: string | null =
          drawRouteMode
            ? COPY.drawRouteBanner + (pendingVertices.length > 0 ? ` (${pendingVertices.length} vertices)` : '')
          : drawRegionMode
            ? COPY.drawRegionBanner + (pendingVertices.length > 0 ? ` (${pendingVertices.length} vertices)` : '')
          : (armedTerrainTypeId && !drawRegionMode)
            ? COPY.paintTerrainBanner(armedTypeName) + (pendingVertices.length > 0 ? ` (${pendingVertices.length} vertices)` : '')
          : (addPinMode && !entryPickerOpen)
            ? COPY.hintBanner
          : null;

        if (!bannerText) return null;
        return (
          <div
            data-testid="map-hint-banner"
            className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 px-3"
          >
            <div className="rounded-full px-3 py-1 text-xs shadow-sm whitespace-nowrap border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]">
              {bannerText}
            </div>
          </div>
        );
      })()}

      {/* Map canvas — d3-zoom + React-rendered pins + regions.
          In share mode: addPinMode/drawRegionMode forced false; mutation
          callbacks (context menus) are no-ops (T-40-12).
          canvasRef exposes the imperative zoom seam for MapZoomControls (D-04, Plan 02). */}
      <MapCanvas
        ref={canvasRef}
        imageUrl={map.rawUrl}
        imageWidth={imageWidth}
        imageHeight={imageHeight}
        pins={enrichedPins}
        regions={regions}
        addPinMode={isShare ? false : addPinMode}
        drawRegionMode={isShare ? false : drawRegionMode}
        pendingVertices={isShare ? [] : pendingVertices}
        selectedPinId={isShare ? null : selectedPinId}
        universeId={uid}
        medallions={medallions}
        onCanvasClick={isShare ? () => {} : handleCanvasClick}
        onPinDragEnd={isShare ? () => {} : handlePinDragEnd}
        onPinContextMenu={isShare ? () => {} : handlePinContextMenu}
        onRegionClick={handleRegionClick}
        onRegionContextMenu={isShare ? () => {} : handleRegionContextMenu}
        terrainAreas={terrainAreas}
        layers={layers}
        layerViewerState={layerViewerState}
        paintTerrainMode={!isShare && !!armedTerrainTypeId}
        onTerrainAreaContextMenu={isShare ? () => {} : handleTerrainAreaContextMenu}
        gridVisible={gridVisible}
        routes={map?.routes ?? []}
        onRouteClick={handleRouteClick}
        onRouteContextMenu={isShare ? () => {} : handleRouteContextMenu}
        drawRouteMode={!isShare && drawRouteMode}
        onCanvasDblClick={isShare ? undefined : handleCanvasDblClick}
        onRouteVertexAtPin={isShare ? undefined : (pin) => {
          if (!drawRouteMode) return;
          setPendingVertices((v) => [...v, { x: pin.x, y: pin.y }]);
        }}
        highlightedItemId={highlightedItemId}
        onOpenMap={handleOpenMap}
      />

      {/* Phase 53 NEST-01 D-03: single-level breadcrumb — rendered in BOTH editor and share.
          Sits at absolute left-4 top-4 z-20. The MapToolbar shifts to top-16 (hasBreadcrumb)
          so they do not overlap (UI-SPEC §3). Only rendered when router nav state carries `from`.
          No edit-only variant — share visitors also navigate nested maps. */}
      {fromOrigin && (
        <MapBreadcrumb
          originMapId={fromOrigin.id}
          originMapName={fromOrigin.name}
          shareToken={shareToken}
          universeId={uid}
        />
      )}

      {/* ── Glassy map chrome — rendered in BOTH editor and share mode (D-09 parity) ── */}
      {/* CRITICAL: NOT gated on !isShare — zoom controls + compass are always visible. */}
      {/* MapZoomControls: bottom-right cluster; wired to canvasRef imperative zoom seam (D-04). */}
      <MapZoomControls
        onZoomIn={() => canvasRef.current?.zoomIn()}
        onZoomOut={() => canvasRef.current?.zoomOut()}
        onFitReset={() => canvasRef.current?.fitReset()}
        gridVisible={gridVisible}
        onToggleGrid={() => setGridVisible((v) => !v)}
      />
      {/* MapCompass: static decorative compass rose, bottom-left corner (D-06). */}
      <MapCompass />

      {/* Map legend (auto-derived, pointer-events-none overlay).
          In share mode: onRenameLabel is a no-op — captions are not editable. */}
      <MapLegend
        pins={enrichedPins}
        regions={regions}
        legendLabels={legendLabels}
        onRenameLabel={isShare ? () => {} : handleLegendRenameLabel}
        visible={legendVisible}
        onToggle={() => setLegendVisible((v) => !v)}
        layers={layers}
        terrainAreas={terrainAreas}
        layerViewerState={layerViewerState}
      />

      {/* Layers panel — suppressed in share mode (T-42-11 / D-42-03).
          Edit-only surface; share visitors never see the palette manager. */}
      <LayersPanel
        universeId={uid}
        visible={!isShare && layersPanelVisible}
        onToggle={() => setLayersPanelVisible((v) => !v)}
        onRequestColorPick={handleRequestColorPick}
        armedTerrainTypeId={armedTerrainTypeId}
        onArmTerrainType={handleArmTerrainType}
        layerViewerState={layerViewerState}
        onLayerViewerStateChange={handleLayerViewerStateChange}
      />

      {/* No-pins empty state overlay — suppressed in share mode (no mutation CTA).
          BUG-2 fix: also hide when ANY draw mode is active so this pointer-events-auto
          div cannot intercept canvas clicks and steal vertex placements (BUG-3 root cause:
          the CTA card sits at the map center with pointer-events-auto; a click landing on
          it sets addPinMode=true without appending a route vertex, making the click appear
          to "not register" for route drawing). */}
      {!isShare &&
        !drawRouteMode && !drawRegionMode && !armedTerrainTypeId && !addPinMode &&
        enrichedPins.length === 0 && regions.length === 0 && terrainAreas.length === 0 && (
        <div data-testid="map-empty-state-cta" className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <div className="pointer-events-auto">
            <EmptyState
              title={COPY.noPinsTitle}
              body={COPY.noPinsBody}
              action={
                <button
                  type="button"
                  onClick={() => {
                    // Mirror the toolbar onToggleAddPinMode exclusion: clear all draw modes
                    // before arming addPinMode so the two-mode overlap cannot occur even if
                    // this button is clicked while some draw mode is transitioning.
                    if (drawRegionMode) setDrawRegionMode(false);
                    if (drawRouteMode) { setDrawRouteMode(false); setPendingVertices([]); }
                    if (armedTerrainTypeId) { setArmedTerrainTypeId(null); setArmedLayerId(null); }
                    setAddPinMode(true);
                  }}
                  className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-2"
                >
                  {COPY.noPinsCta}
                </button>
              }
            />
          </div>
        </div>
      )}

      {/* Mutation affordances — all suppressed in share mode (T-40-12) */}
      {!isShare && (
        <>
          {/* Entry picker for add-pin */}
          <AddEntriesPicker
            entries={universeEntries}
            placedEntryIds={new Set()}
            onAdd={handleEntryAdd}
            onRemove={() => { /* no-op */ }}
            onClose={() => {
              setEntryPickerOpen(false);
              setPendingPinCoords(null);
            }}
            open={entryPickerOpen}
          />

          {/* Entry picker for relink pin */}
          <AddEntriesPicker
            entries={universeEntries}
            placedEntryIds={new Set()}
            onAdd={handleRelinkEntry}
            onRemove={() => { /* no-op in relink mode */ }}
            onClose={() => {
              setRelinkPickerOpen(false);
              setSelectedPinId(null);
            }}
            open={relinkPickerOpen}
          />

          {/* Entry picker for region relink */}
          <AddEntriesPicker
            entries={universeEntries}
            placedEntryIds={new Set()}
            onAdd={handleRegionRelinkEntry}
            onRemove={() => { /* no-op */ }}
            onClose={() => { setRegionRelinkPickerOpen(false); setRegionRelinkTarget(null); }}
            open={regionRelinkPickerOpen}
          />

          {/* Entry picker for route relink (ROUTE-02, Plan 07) */}
          <AddEntriesPicker
            entries={universeEntries}
            placedEntryIds={new Set()}
            onAdd={handleRouteRelinkEntry}
            onRemove={() => { /* no-op */ }}
            onClose={() => { setRouteRelinkPickerOpen(false); setRouteRelinkTarget(null); }}
            open={routeRelinkPickerOpen}
          />

          {/* Phase 53 NEST-01 D-01: map picker for linking a target map to a pin or region.
              currentTargetMapId derives from whichever item is being edited (pin XOR region).
              onClose clears picker state; onSelect/onUnlink fire mutations then picker calls onClose. */}
          <MapPickerModal
            open={mapPickerOpen}
            onClose={() => {
              setMapPickerOpen(false);
              setMapPickerPin(null);
              setMapPickerRegion(null);
            }}
            onSelect={handleSelectTargetMap}
            onUnlink={handleUnlinkTargetMap}
            currentMapId={mid}
            currentTargetMapId={mapPickerPin?.targetMapId ?? mapPickerRegion?.targetMapId ?? null}
            universeId={uid}
          />

          {/* Change image picker */}
          <AssetPickerModal
            open={changeImageOpen}
            onOpenChange={setChangeImageOpen}
            universeId={uid}
            mode="set-cover"
            onSelect={handleChangeImageSelect}
          />
        </>
      )}

      {/* Context menus + confirm dialogs + style pickers — all mutation affordances
          suppressed in share mode. The no-op context-menu callbacks above mean
          these will never open, but we also DOM-omit them for defense in depth
          (T-40-12). */}
      {!isShare && contextMenu && (
        <div
          id="map-context-menu"
          role="menu"
          aria-label="Pin actions"
          className="fixed z-50 min-w-[140px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg"
          style={{ top: contextMenu.clientY, left: contextMenu.clientX }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleContextMenuDelete}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400"
          >
            {COPY.contextMenuDelete}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleContextMenuRelink}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.contextMenuRelink}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleContextMenuPinColor}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Change color...
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleContextMenuPinGlyph}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Change icon...
          </button>
          {/* Phase 52 SECRET-01: toggle secret (D-01). Normal color/style preserved. */}
          <button
            type="button"
            role="menuitem"
            onClick={handleContextMenuTogglePinSecret}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {contextMenu?.pin.secret ? COPY.contextMenuUnmarkSecret : COPY.contextMenuMarkSecret}
          </button>
          {/* Phase 53 NEST-01 D-01: "Opens: {mapName}" indicator + "Link to map…" + "Unlink map".
              Independent of the existing "Change entry…" item — both/either/neither may be set.
              Suppressed in share mode (whole menu is !isShare-gated above). */}
          {contextMenu.pin.targetMapId && (() => {
            const targetMap = allMaps.find((m) => m.id === contextMenu.pin.targetMapId);
            return (
              <p className="text-xs text-neutral-500 dark:text-neutral-400 px-3 py-1.5 truncate" role="presentation">
                Opens: {targetMap?.name ?? '…'}
              </p>
            );
          })()}
          <button
            type="button"
            role="menuitem"
            onClick={handleContextMenuLinkMap}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.linkToMap}
          </button>
          {contextMenu.pin.targetMapId && (
            <button
              type="button"
              role="menuitem"
              onClick={handleContextMenuUnlinkMapPin}
              className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              {COPY.unlinkMap}
            </button>
          )}
        </div>
      )}

      {/* Region context menu — suppressed in share mode */}
      {!isShare && regionContextMenu && (
        <div
          id="map-region-context-menu"
          role="menu"
          aria-label="Region actions"
          className="fixed z-50 min-w-[140px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg"
          style={{ top: regionContextMenu.clientY, left: regionContextMenu.clientX }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleRegionContextMenuDelete}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400"
          >
            {COPY.regionContextMenuDelete}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleRegionContextMenuRelink}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.regionContextMenuRelink}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleRegionContextMenuRename}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.regionContextMenuRename}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleRegionContextMenuColor}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.regionContextMenuColor}
          </button>
          {/* Phase 52 SECRET-01: toggle secret (D-01). Normal color/style preserved. */}
          <button
            type="button"
            role="menuitem"
            onClick={handleRegionContextMenuToggleSecret}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {regionContextMenu?.region.secret ? COPY.contextMenuUnmarkSecret : COPY.contextMenuMarkSecret}
          </button>
          {/* Phase 53 NEST-01 D-01: map-link items — independent of "Change entry…" item. */}
          {regionContextMenu.region.targetMapId && (() => {
            const targetMap = allMaps.find((m) => m.id === regionContextMenu.region.targetMapId);
            return (
              <p className="text-xs text-neutral-500 dark:text-neutral-400 px-3 py-1.5 truncate" role="presentation">
                Opens: {targetMap?.name ?? '…'}
              </p>
            );
          })()}
          <button
            type="button"
            role="menuitem"
            onClick={handleRegionContextMenuLinkMap}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.linkToMap}
          </button>
          {regionContextMenu.region.targetMapId && (
            <button
              type="button"
              role="menuitem"
              onClick={handleRegionContextMenuUnlinkMap}
              className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              {COPY.unlinkMap}
            </button>
          )}
        </div>
      )}

      {/* Terrain area context menu (43-04) — distinct from region menu; suppressed in share mode */}
      {!isShare && terrainContextMenu && (
        <div
          id="map-terrain-context-menu"
          role="menu"
          aria-label="Terrain area actions"
          className="fixed z-50 min-w-[140px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg"
          style={{ top: terrainContextMenu.clientY, left: terrainContextMenu.clientX }}
        >
          {/* Reclassify ▸ — opens grouped submenu */}
          <button
            type="button"
            role="menuitem"
            onClick={() => setReclassifySubmenuOpen((v) => !v)}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.terrainContextMenuReclassify}
          </button>
          {/* Delete area — instant, no ConfirmDialog (D-43-02) */}
          <button
            type="button"
            role="menuitem"
            aria-label="Delete terrain area"
            onClick={handleTerrainContextMenuDelete}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400"
          >
            {COPY.terrainContextMenuDelete}
          </button>
          {/* Reclassify submenu — inline expansion (D-43-03) */}
          {reclassifySubmenuOpen && (
            <div
              role="menu"
              aria-label="Reclassify terrain area"
              className="border-t border-neutral-100 dark:border-neutral-800"
            >
              {[...layers]
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((layer) => {
                  const sortedTypes = [...(layer.terrainTypes ?? [])].sort(
                    (a, b) => a.sortOrder - b.sortOrder,
                  );
                  if (sortedTypes.length === 0) return null;
                  return (
                    <div key={layer.id}>
                      {/* Layer group heading (role=presentation per UI-SPEC) */}
                      <div
                        role="presentation"
                        className="text-xs font-semibold uppercase text-neutral-500 px-3 py-1"
                      >
                        {layer.name}
                      </div>
                      {sortedTypes.map((type) => {
                        const isCurrent = type.id === terrainContextMenu.region.terrainTypeId;
                        return (
                          <button
                            key={type.id}
                            type="button"
                            role="menuitem"
                            onClick={() => handleTerrainReclassify(type.id)}
                            className="w-full text-left text-sm px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800 flex items-center gap-2"
                          >
                            <span
                              className="w-3 h-3 rounded-full flex-shrink-0"
                              style={{ backgroundColor: type.color }}
                              aria-hidden="true"
                            />
                            <span className="text-neutral-700 dark:text-neutral-300">
                              {isCurrent && <span className="mr-1">✓</span>}
                              {type.name}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* Route context menu (ROUTE-02, Plan 07) — suppressed in share mode (T-51-13) */}
      {!isShare && routeContextMenu && (
        <div
          id="map-route-context-menu"
          role="menu"
          aria-label="Route actions"
          className="fixed z-50 min-w-[160px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg"
          style={{ top: routeContextMenu.clientY, left: routeContextMenu.clientX }}
        >
          {/* Route-only restyle controls (D-06) */}
          <button
            type="button"
            role="menuitem"
            onClick={handleRouteContextMenuLineStyle}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.routeContextMenuLineStyle(routeContextMenu.route.lineStyle)}
          </button>
          {/* Width preset picker: thin(2) / medium(4) / thick(7) */}
          <div role="presentation" className="text-xs uppercase text-neutral-500 px-3 py-1 border-t border-neutral-100 dark:border-neutral-800">
            Width
          </div>
          {([['Thin', 2], ['Medium', 4], ['Thick', 7]] as const).map(([label, w]) => (
            <button
              key={w}
              type="button"
              role="menuitem"
              onClick={() => handleRouteContextMenuWidth(w)}
              className={[
                'w-full text-left text-sm px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800 flex items-center gap-2',
                routeContextMenu.route.width === w ? 'font-semibold text-[color:var(--color-accent)]' : '',
              ].join(' ')}
            >
              <span className="inline-block h-0.5 w-6 rounded-full" style={{ height: `${Math.max(1, w / 2)}px`, backgroundColor: 'currentColor' }} aria-hidden="true" />
              {label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={handleRouteContextMenuArrow}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 border-t border-neutral-100 dark:border-neutral-800"
          >
            {COPY.routeContextMenuArrow(routeContextMenu.route.showArrow)}
          </button>
          {/* Standard rename / relink / color / delete */}
          <button
            type="button"
            role="menuitem"
            onClick={handleRouteContextMenuRename}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 border-t border-neutral-100 dark:border-neutral-800"
          >
            {COPY.routeContextMenuRename}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleRouteContextMenuRelink}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.routeContextMenuRelink}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleRouteContextMenuColor}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {COPY.routeContextMenuColor}
          </button>
          {/* Phase 52 SECRET-01: toggle secret (D-01). Normal color/style preserved. */}
          <button
            type="button"
            role="menuitem"
            onClick={handleRouteContextMenuToggleSecret}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {routeContextMenu?.route.secret ? COPY.contextMenuUnmarkSecret : COPY.contextMenuMarkSecret}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleRouteContextMenuDelete}
            className="w-full text-left text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 text-red-600 dark:text-red-400 border-t border-neutral-100 dark:border-neutral-800"
          >
            {COPY.routeContextMenuDelete}
          </button>
        </div>
      )}

      {/* Delete / rename / color / glyph dialogs — suppressed in share mode */}
      {!isShare && (
        <>
          <ConfirmDialog
            open={deletePinTarget !== null}
            onOpenChange={(open) => {
              if (!open) {
                setDeletePinTarget(null);
                setSelectedPinId(null);
              }
            }}
            title={COPY.deletePinTitle(
              enrichedPins.find((p) => p.id === deletePinTarget?.id)?.entryTitle ??
                deletePinTitle,
            )}
            body={COPY.deletePinBody}
            confirmLabel={COPY.deletePinConfirm}
            destructive
            onConfirm={handleDeletePinConfirm}
          />

          <ConfirmDialog
            open={deleteRegionTarget !== null}
            onOpenChange={(open) => {
              if (!open) setDeleteRegionTarget(null);
            }}
            title={COPY.deleteRegionTitle(deleteRegionTarget?.name || 'this region')}
            body={COPY.deleteRegionBody}
            confirmLabel={COPY.deleteRegionConfirm}
            destructive
            onConfirm={handleDeleteRegionConfirm}
          />

          {/* Region rename dialog */}
          {renameRegionTarget && (
            <div
              role="dialog"
              aria-label="Rename region"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={(e) => { if (e.target === e.currentTarget) setRenameRegionTarget(null); }}
            >
              <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 w-72 flex flex-col gap-3">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Rename region</p>
                <input
                  type="text"
                  value={renameRegionDraft}
                  onChange={(e) => setRenameRegionDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRegionRenameConfirm();
                    if (e.key === 'Escape') setRenameRegionTarget(null);
                  }}
                  className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-sm px-3 py-2 outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                  autoFocus
                  placeholder="Region name"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRenameRegionTarget(null)}
                    className="text-sm px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRegionRenameConfirm}
                    className="text-sm px-3 py-1.5 rounded-md bg-[color:var(--color-accent)] text-white hover:opacity-90"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Color picker for pin (MAP_COLOR_PALETTE swatches, D-01) */}
          {pinColorTarget && (
            <div
              role="dialog"
              aria-label="Change pin color"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={(e) => { if (e.target === e.currentTarget) setPinColorTarget(null); }}
            >
              <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 flex flex-col gap-3">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Pin color</p>
                <div className="flex flex-wrap gap-2">
                  {MAP_COLOR_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handlePinColorSelect(color)}
                      className="w-7 h-7 rounded-full border-2 border-transparent hover:scale-110 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                      style={{
                        backgroundColor: color,
                        borderColor: pinColorTarget.color === color ? '#111827' : 'transparent',
                      }}
                      aria-label={color}
                      title={color}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => handlePinColorSelect(entryTypeHexColor(pinColorTarget.entryType ?? 'concept'))}
                    className="text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    title="Reset to entry type color"
                  >
                    Reset
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setPinColorTarget(null)}
                  className="text-xs text-neutral-400 hover:text-neutral-600 self-end"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Glyph picker for pin (MAP_GLYPH_KEYS, D-02) */}
          {glyphPickerTarget && (
            <div
              role="dialog"
              aria-label="Change pin icon"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={(e) => { if (e.target === e.currentTarget) setGlyphPickerTarget(null); }}
            >
              <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 flex flex-col gap-3">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Pin icon</p>
                <div className="flex flex-wrap gap-2 max-w-xs">
                  {MAP_GLYPH_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handlePinGlyphSelect(key)}
                      className={[
                        'w-9 h-9 rounded-md border flex items-center justify-center hover:bg-neutral-50 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
                        glyphPickerTarget.icon === key
                          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)]'
                          : 'border-neutral-300 dark:border-neutral-700',
                      ].join(' ')}
                      aria-label={key}
                      title={key}
                    >
                      <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <g dangerouslySetInnerHTML={{ __html: getGlyphPath(key) ?? '' }} />
                      </svg>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => handlePinGlyphSelect(null)}
                    className="text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    title="Remove icon"
                  >
                    None
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setGlyphPickerTarget(null)}
                  className="text-xs text-neutral-400 hover:text-neutral-600 self-end"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Color picker for region (MAP_COLOR_PALETTE swatches, D-01) */}
          {regionColorTarget && (
            <div
              role="dialog"
              aria-label="Change region color"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={(e) => { if (e.target === e.currentTarget) setRegionColorTarget(null); }}
            >
              <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 flex flex-col gap-3">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Region color</p>
                <div className="flex flex-wrap gap-2">
                  {MAP_COLOR_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handleRegionColorSelect(color)}
                      className="w-7 h-7 rounded-full border-2 border-transparent hover:scale-110 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                      style={{
                        backgroundColor: color,
                        borderColor: regionColorTarget.color === color ? '#111827' : 'transparent',
                      }}
                      aria-label={color}
                      title={color}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setRegionColorTarget(null)}
                  className="text-xs text-neutral-400 hover:text-neutral-600 self-end"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Route delete confirm dialog (ROUTE-02, Plan 07) */}
          <ConfirmDialog
            open={deleteRouteTarget !== null}
            onOpenChange={(open) => {
              if (!open) setDeleteRouteTarget(null);
            }}
            title={COPY.deleteRouteTitle(deleteRouteTarget?.name || 'this route')}
            body={COPY.deleteRouteBody}
            confirmLabel={COPY.deleteRouteConfirm}
            destructive
            onConfirm={handleDeleteRouteConfirm}
          />

          {/* Route rename dialog (ROUTE-02, Plan 07) */}
          {renameRouteTarget && (
            <div
              role="dialog"
              aria-label="Rename route"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={(e) => { if (e.target === e.currentTarget) setRenameRouteTarget(null); }}
            >
              <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 w-72 flex flex-col gap-3">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Rename route</p>
                <input
                  type="text"
                  value={renameRouteDraft}
                  onChange={(e) => setRenameRouteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleRouteRenameConfirm();
                    if (e.key === 'Escape') setRenameRouteTarget(null);
                  }}
                  className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-sm px-3 py-2 outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                  autoFocus
                  placeholder="Route name"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRenameRouteTarget(null)}
                    className="text-sm px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRouteRenameConfirm()}
                    className="text-sm px-3 py-1.5 rounded-md bg-[color:var(--color-accent)] text-white hover:opacity-90"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Color picker for route (MAP_COLOR_PALETTE swatches, D-06) */}
          {routeColorTarget && (
            <div
              role="dialog"
              aria-label="Change route color"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={(e) => { if (e.target === e.currentTarget) setRouteColorTarget(null); }}
            >
              <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 flex flex-col gap-3">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Route color</p>
                <div className="flex flex-wrap gap-2">
                  {MAP_COLOR_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => void handleRouteColorSelect(color)}
                      className="w-7 h-7 rounded-full border-2 border-transparent hover:scale-110 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                      style={{
                        backgroundColor: color,
                        borderColor: routeColorTarget.color === color ? '#111827' : 'transparent',
                      }}
                      aria-label={color}
                      title={color}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setRouteColorTarget(null)}
                  className="text-xs text-neutral-400 hover:text-neutral-600 self-end"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Color picker for LayersPanel terrain-type swatches (D-42-07).
              Opened via onRequestColorPick callback; forwards selection to LayersPanel. */}
          {layersColorPickerOpen && (
            <div
              role="dialog"
              aria-label="Change terrain type color"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setLayersColorPickerOpen(false);
                  setLayersColorPickerCallback(null);
                }
              }}
            >
              <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl p-5 flex flex-col gap-3">
                <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Terrain type color</p>
                <div className="flex flex-wrap gap-2">
                  {MAP_COLOR_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => {
                        layersColorPickerCallback?.(color);
                        setLayersColorPickerOpen(false);
                        setLayersColorPickerCallback(null);
                      }}
                      className="w-7 h-7 rounded-full border-2 border-transparent hover:scale-110 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                      style={{
                        backgroundColor: color,
                        borderColor: layersColorPickerCurrent === color ? '#111827' : 'transparent',
                      }}
                      aria-label={color}
                      title={color}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLayersColorPickerOpen(false);
                    setLayersColorPickerCallback(null);
                  }}
                  className="text-xs text-neutral-400 hover:text-neutral-600 self-end"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Toast for transient errors */}
      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onDismiss={() => setToast(null)}
          durationMs={3000}
        />
      )}
    </div>
  );
}
