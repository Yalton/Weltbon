import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AddEntriesPicker } from '../components/AddEntriesPicker';
import { AssetPickerModal } from '../components/AssetPickerModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { MapCanvas } from '../components/MapCanvas';
import { MapToolbar } from '../components/MapToolbar';
import { Toast } from '../components/Toast';
import { useEntries } from '../hooks/useEntries';
import {
  useAddPin,
  useDeletePin,
  useMap,
  useMovePin,
  useRelinkPin,
  useUpdateMap,
  type MapPin,
} from '../hooks/useMap';

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
  noPinsTitle: 'No pins yet',
  noPinsBody: 'Switch to Add pin mode and click the map to place your first entry link.',
  noPinsCta: 'Add pin',
  pinSaveError: "Couldn't save pin. Try again.",
  pinDeleteError: "Couldn't delete pin. Try again.",
  deletePinTitle: (entryTitle: string) => `Delete pin for "${entryTitle}"?`,
  deletePinBody:
    'This removes the pin from the map. The linked entry is not affected.',
  deletePinConfirm: 'Delete pin',
  contextMenuDelete: 'Delete pin',
  contextMenuRelink: 'Change entry...',
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type ToastState = { message: string; variant: 'error' | 'success' } | null;

/** State for the positioned context menu. */
type ContextMenuState = {
  pin: MapPin;
  clientX: number;
  clientY: number;
} | null;

// ─── MapEditor ────────────────────────────────────────────────────────────────

/**
 * `/universes/:uid/maps/:mid` — map editor view.
 *
 * Orchestrates: MapCanvas, MapToolbar, AddEntriesPicker, AssetPickerModal,
 * ConfirmDialog (delete pin), Toast, EmptyState overlay.
 *
 * Add-pin flow (D-05): addPinMode → canvas click captures coords → opens
 * AddEntriesPicker → onAdd(entryId) calls useAddPin → picker stays open for
 * additional placements; addPinMode stays active.
 *
 * Drag-reposition (D-06): MapCanvas onPinDragEnd → useMovePin.
 * Click pin: MapCanvas PinCircle distinguishes click from drag; navigates
 * to /universes/:uid/entries/:entryId same-tab.
 *
 * Change image (D-03): AssetPickerModal → useUpdateMap({ imageAssetId }).
 * Stored pin normalized coords are preserved unchanged.
 *
 * Esc priority (mirrors DiagramEditor layered useEffects):
 *   1. Entry picker open → close picker; addPinMode stays active.
 *   2. Context menu open → close menu.
 *   3. addPinMode active (no picker/menu open) → exit addPinMode.
 *
 * Pins are joined with useEntries(uid) to supply entryTitle/entryType before
 * passing to MapCanvas — the API returns bare map_pins rows without entry join.
 */
export function MapEditor() {
  const { uid = '', mid = '' } = useParams<{ uid: string; mid: string }>();
  const navigate = useNavigate();

  // ── Data hooks ───────────────────────────────────────────────────────────────
  const { data: map, isLoading, isError } = useMap(uid, mid);
  const { data: entriesData } = useEntries(uid);
  const addPin = useAddPin(uid, mid);
  const movePin = useMovePin(uid, mid);
  const deletePin = useDeletePin(uid, mid);
  const relinkPin = useRelinkPin(uid, mid);
  const updateMap = useUpdateMap(uid, mid);

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
  const [pendingPinCoords, setPendingPinCoords] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [entryPickerOpen, setEntryPickerOpen] = useState(false);
  const [changeImageOpen, setChangeImageOpen] = useState(false);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [deletePinTarget, setDeletePinTarget] = useState<MapPin | null>(null);
  const [relinkPickerOpen, setRelinkPickerOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  // ── Join pins with entries ────────────────────────────────────────────────────
  // The API returns bare map_pins rows (id, mapId, entryId, x, y).
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

  // ── Esc priority (three layered useEffects, mirrors DiagramEditor 254-272) ───

  // Priority 1: entry picker open → close picker; addPinMode stays active.
  useEffect(() => {
    if (!entryPickerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEntryPickerOpen(false);
        setPendingPinCoords(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [entryPickerOpen]);

  // Priority 2: context menu open → close context menu.
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
        setSelectedPinId(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [contextMenu]);

  // Priority 3: addPinMode active (no picker/menu open) → exit addPinMode.
  useEffect(() => {
    if (!addPinMode || entryPickerOpen || contextMenu) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAddPinMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addPinMode, entryPickerOpen, contextMenu]);

  // ── Add-pin flow handlers ────────────────────────────────────────────────────

  /**
   * Called by MapCanvas when user clicks the canvas in addPinMode.
   * Stores pending normalized coords and opens the entry picker.
   */
  const handleCanvasClick = useCallback((nx: number, ny: number) => {
    setPendingPinCoords({ x: nx, y: ny });
    setEntryPickerOpen(true);
  }, []);

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

  // ── Context menu handlers ────────────────────────────────────────────────────

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

  // ── Change image handler ─────────────────────────────────────────────────────

  const handleChangeImageSelect = async (assetId: string) => {
    setChangeImageOpen(false);
    try {
      await updateMap.mutateAsync({ imageAssetId: assetId });
    } catch {
      setToast({ message: COPY.pinSaveError, variant: 'error' });
    }
  };

  // ── Click-away to close context menu ─────────────────────────────────────────
  // Using a mousedown listener on the window so clicking anywhere outside
  // the context menu (which is rendered in a portal-like <div>) closes it.
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      const menu = document.getElementById('map-context-menu');
      if (menu && !menu.contains(e.target as Node)) {
        setContextMenu(null);
        setSelectedPinId(null);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  // ── Render ────────────────────────────────────────────────────────────────────

  if (isLoading) {
    return <p className="p-6 text-sm text-neutral-500">{COPY.loading}</p>;
  }

  if (isError || !map) {
    return <p className="p-6 text-sm text-red-500">{COPY.error}</p>;
  }

  // The currently-selected pin's enriched record (for delete confirm title).
  const selectedPinData =
    enrichedPins.find((p) => p.id === (deletePinTarget?.id ?? selectedPinId)) ??
    null;
  const deletePinTitle = deletePinTarget?.entryTitle ??
    enrichedPins.find((p) => p.id === deletePinTarget?.id)?.entryTitle ??
    'this entry';

  return (
    <div className="relative h-[calc(100vh-7rem)] w-full overflow-hidden">
      {/* Floating toolbar overlay */}
      <MapToolbar
        mapName={map.name}
        addPinMode={addPinMode}
        onToggleAddPinMode={() => setAddPinMode((v) => !v)}
        onChangeImage={() => setChangeImageOpen(true)}
      />

      {/* Add-pin hint banner — shown in addPinMode when no picker is open */}
      {addPinMode && !entryPickerOpen && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 px-3">
          <div className="rounded-full px-3 py-1 text-xs shadow-sm whitespace-nowrap border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]">
            {COPY.hintBanner}
          </div>
        </div>
      )}

      {/* Map canvas — d3-zoom + React-rendered pins */}
      <MapCanvas
        imageUrl={map.rawUrl}
        imageWidth={imageWidth}
        imageHeight={imageHeight}
        pins={enrichedPins}
        addPinMode={addPinMode}
        selectedPinId={selectedPinId}
        universeId={uid}
        onCanvasClick={handleCanvasClick}
        onPinDragEnd={handlePinDragEnd}
        onPinContextMenu={handlePinContextMenu}
      />

      {/* No-pins empty state overlay (D-11: shown when pins.length === 0) */}
      {enrichedPins.length === 0 && (
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

      {/* Entry picker for add-pin (placedEntryIds=empty Set — multiple pins per entry allowed, D-11) */}
      <AddEntriesPicker
        entries={universeEntries}
        placedEntryIds={new Set()}
        onAdd={handleEntryAdd}
        onRemove={() => {
          /* no-op — we don't show "remove" in add-pin mode */
        }}
        onClose={() => {
          setEntryPickerOpen(false);
          setPendingPinCoords(null);
        }}
        open={entryPickerOpen}
      />

      {/* Entry picker for relink (reuses AddEntriesPicker in relink mode) */}
      <AddEntriesPicker
        entries={universeEntries}
        placedEntryIds={new Set()}
        onAdd={handleRelinkEntry}
        onRemove={() => {
          /* no-op in relink mode */
        }}
        onClose={() => {
          setRelinkPickerOpen(false);
          setSelectedPinId(null);
        }}
        open={relinkPickerOpen}
      />

      {/* Change image picker */}
      <AssetPickerModal
        open={changeImageOpen}
        onOpenChange={setChangeImageOpen}
        universeId={uid}
        mode="set-cover"
        onSelect={handleChangeImageSelect}
      />

      {/* Pin context menu — positioned at clientX/Y */}
      {contextMenu && (
        <div
          id="map-context-menu"
          role="menu"
          aria-label="Pin actions"
          className="fixed z-50 min-w-[140px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg"
          style={{
            top: contextMenu.clientY,
            left: contextMenu.clientX,
          }}
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
        </div>
      )}

      {/* Delete pin confirm dialog */}
      <ConfirmDialog
        open={deletePinTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletePinTarget(null);
            setSelectedPinId(null);
          }
        }}
        title={COPY.deletePinTitle(
          deletePinTarget
            ? (enrichedPins.find((p) => p.id === deletePinTarget.id)?.entryTitle ??
                deletePinTitle)
            : deletePinTitle,
        )}
        body={COPY.deletePinBody}
        confirmLabel={COPY.deletePinConfirm}
        destructive
        onConfirm={handleDeletePinConfirm}
      />

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
