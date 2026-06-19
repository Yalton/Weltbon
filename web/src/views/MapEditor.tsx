import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AddEntriesPicker } from '../components/AddEntriesPicker';
import { AssetPickerModal } from '../components/AssetPickerModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { MapCanvas } from '../components/MapCanvas';
import { MapLegend } from '../components/MapLegend';
import { MapToolbar } from '../components/MapToolbar';
import { Toast } from '../components/Toast';
import { useEntries } from '../hooks/useEntries';
import {
  useAddPin,
  useCreateRegion,
  useDeletePin,
  useDeleteRegion,
  useMap,
  useMovePin,
  useRelinkPin,
  useUpdateMap,
  useUpdatePinStyle,
  useUpdateRegion,
  type MapPin,
  type MapRegion,
} from '../hooks/useMap';
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
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type ToastState = { message: string; variant: 'error' | 'success' } | null;

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

  // ── Data hooks ───────────────────────────────────────────────────────────────
  const { data: map, isLoading, isError } = useMap(uid, mid);
  const { data: entriesData } = useEntries(uid);
  const addPin = useAddPin(uid, mid);
  const movePin = useMovePin(uid, mid);
  const deletePin = useDeletePin(uid, mid);
  const relinkPin = useRelinkPin(uid, mid);
  const updateMap = useUpdateMap(uid, mid);
  const updatePinStyle = useUpdatePinStyle(uid, mid);
  const createRegion = useCreateRegion(uid, mid);
  const updateRegion = useUpdateRegion(uid, mid);
  const deleteRegion = useDeleteRegion(uid, mid);

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

  // ── Draw-region mode state ────────────────────────────────────────────────────
  const [drawRegionMode, setDrawRegionMode] = useState(false);
  const [pendingVertices, setPendingVertices] = useState<Array<{ x: number; y: number }>>([]);
  const [regionContextMenu, setRegionContextMenu] = useState<RegionContextMenuState>(null);
  const [deleteRegionTarget, setDeleteRegionTarget] = useState<MapRegion | null>(null);
  const [regionRelinkPickerOpen, setRegionRelinkPickerOpen] = useState(false);
  const [renameRegionTarget, setRenameRegionTarget] = useState<MapRegion | null>(null);
  const [renameRegionDraft, setRenameRegionDraft] = useState('');
  // Color picker state (for pins and regions)
  const [pinColorTarget, setPinColorTarget] = useState<MapPin | null>(null);
  const [regionColorTarget, setRegionColorTarget] = useState<MapRegion | null>(null);
  const [glyphPickerTarget, setGlyphPickerTarget] = useState<MapPin | null>(null);

  // ── Join pins with entries ────────────────────────────────────────────────────
  // The API returns bare map_pins rows (id, mapId, entryId, x, y, color, icon).
  // We join here to supply entryTitle/entryType for MapCanvas pin display (D-09).
  const enrichedPins = useMemo<MapPin[]>(() => {
    if (!map?.pins) return [];
    if (!entriesData) return map.pins;
    const entryMap = new Map(entriesData.map((e) => [e.id, e]));
    return map.pins.map((pin) => {
      const entry = entryMap.get(pin.entryId);
      return {
        ...pin,
        entryTitle: entry?.title ?? pin.entryTitle,
        entryType: entry?.entryType ?? pin.entryType,
      };
    });
  }, [map?.pins, entriesData]);

  // ── Regions from map payload ──────────────────────────────────────────────────
  const regions = useMemo<MapRegion[]>(() => map?.regions ?? [], [map?.regions]);

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

  // Priority 3: context menu open → close menu (pin or region).
  useEffect(() => {
    if (!contextMenu && !regionContextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setSelectedPinId(null);
        setRegionContextMenu(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [contextMenu, regionContextMenu]);

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

  // ── Add-pin flow handlers ────────────────────────────────────────────────────

  /**
   * Called by MapCanvas when user clicks the canvas in addPinMode or drawRegionMode.
   * In drawRegionMode: append vertex; snap-close if on first vertex (≥3 verts).
   * In addPinMode: store pending coords and open entry picker.
   */
  const handleCanvasClick = useCallback((nx: number, ny: number) => {
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
  }, [drawRegionMode, handleCloseRegion]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Left-click navigates to linked entry (D-08-click); inert if no entryId.
    // In share mode stay within /share/:token to avoid uid leaks (T-40-14).
    if (region.entryId) {
      if (shareToken) {
        navigate(`/share/${shareToken}/entries/${region.entryId}`);
      } else {
        navigate(`/universes/${uid}/entries/${region.entryId}`);
      }
    }
  }, [navigate, shareToken, uid]);

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
    const region = regionContextMenu?.region ?? null;
    if (!region) {
      setRegionRelinkPickerOpen(false);
      return;
    }
    setRegionRelinkPickerOpen(false);
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
    <div className="relative h-[calc(100vh-7rem)] w-full overflow-hidden">
      {/* Floating toolbar overlay — suppressed in share mode (T-40-12 / D-12) */}
      {!isShare && (
        <MapToolbar
          mapName={map.name}
          addPinMode={addPinMode}
          onToggleAddPinMode={() => {
            setAddPinMode((v) => !v);
            if (drawRegionMode) setDrawRegionMode(false);
          }}
          drawRegionMode={drawRegionMode}
          onToggleDrawRegionMode={() => {
            setDrawRegionMode((v) => !v);
            if (addPinMode) setAddPinMode(false);
            if (!drawRegionMode) setPendingVertices([]);
          }}
          onChangeImage={() => setChangeImageOpen(true)}
          legendVisible={legendVisible}
          onToggleLegend={() => setLegendVisible((v) => !v)}
        />
      )}

      {/* Share-mode legend toggle button (replaces MapToolbar legend toggle) */}
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

      {/* Add-pin hint banner — suppressed in share mode */}
      {!isShare && addPinMode && !entryPickerOpen && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 px-3">
          <div className="rounded-full px-3 py-1 text-xs shadow-sm whitespace-nowrap border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]">
            {COPY.hintBanner}
          </div>
        </div>
      )}

      {/* Draw-region hint banner — suppressed in share mode */}
      {!isShare && drawRegionMode && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 px-3">
          <div className="rounded-full px-3 py-1 text-xs shadow-sm whitespace-nowrap border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]">
            {COPY.drawRegionBanner}
            {pendingVertices.length > 0 && ` (${pendingVertices.length} vertices)`}
          </div>
        </div>
      )}

      {/* Map canvas — d3-zoom + React-rendered pins + regions.
          In share mode: addPinMode/drawRegionMode forced false; mutation
          callbacks (context menus) are no-ops (T-40-12). */}
      <MapCanvas
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
        onCanvasClick={isShare ? () => {} : handleCanvasClick}
        onPinDragEnd={isShare ? () => {} : handlePinDragEnd}
        onPinContextMenu={isShare ? () => {} : handlePinContextMenu}
        onRegionClick={handleRegionClick}
        onRegionContextMenu={isShare ? () => {} : handleRegionContextMenu}
      />

      {/* Map legend (auto-derived, pointer-events-none overlay).
          In share mode: onRenameLabel is a no-op — captions are not editable. */}
      <MapLegend
        pins={enrichedPins}
        regions={regions}
        legendLabels={legendLabels}
        onRenameLabel={isShare ? () => {} : handleLegendRenameLabel}
        visible={legendVisible}
        onToggle={() => setLegendVisible((v) => !v)}
      />

      {/* No-pins empty state overlay — suppressed in share mode (no mutation CTA) */}
      {!isShare && enrichedPins.length === 0 && regions.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <div className="pointer-events-auto">
            <EmptyState
              title={COPY.noPinsTitle}
              body={COPY.noPinsBody}
              action={
                <button
                  type="button"
                  onClick={() => setAddPinMode(true)}
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
            onClose={() => setRegionRelinkPickerOpen(false)}
            open={regionRelinkPickerOpen}
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
