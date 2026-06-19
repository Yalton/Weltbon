import { useState, useEffect, useCallback } from 'react';
import { MAP_COLOR_PALETTE } from '../lib/mapGlyphs';
import {
  useMapLayers,
  useCreateMapLayer,
  useUpdateMapLayer,
  useDeleteMapLayer,
  useCreateTerrainType,
  useUpdateTerrainType,
  useDeleteTerrainType,
  useAddBiomesPreset,
  useAddElevationPreset,
  type MapLayer,
  type TerrainType,
} from '../hooks/useMapLayers';
import { ConfirmDialog } from './ConfirmDialog';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface LayersPanelProps {
  universeId: string;
  visible: boolean;
  onToggle: () => void;
  /**
   * Color picker integration (D-42-07): Plan 04 wires the existing pin/region
   * color picker here. LayersPanel surfaces the callback so that MapEditor can
   * open its shared color picker and forward the result back to the panel.
   * When undefined, swatch clicks are no-ops (graceful until Plan 04 wires it).
   */
  onRequestColorPick?: (
    currentColor: string,
    onPick: (hex: string) => void,
  ) => void;
}

// ─── LayersPanel ──────────────────────────────────────────────────────────────

/**
 * Palette-management panel for universe-wide thematic layers and terrain types.
 *
 * CRITICAL: outer wrapper uses pointer-events-none so d3-zoom on MapCanvas is
 * never blocked. Only the inner panel is pointer-events-auto.
 *
 * Implements the APPROVED UI-SPEC contract (42-UI-SPEC.md):
 * - World-wide scope banner (D-42-04, permanent, no dismiss)
 * - Preset CTAs shown only when no layers exist (D-42-02)
 * - Inline rename on double-click (Enter/blur commit; Esc discard)
 * - Visibility checkbox (local-only state, NO API call — D-42-03)
 * - Opacity slider (PATCH defaultOpacity — D-42-08)
 * - Up/down reorder arrows for ordered layers only (D-42-05)
 * - Height-range label input for ordered-layer types (D-42-06)
 * - Color swatch (cycles MAP_COLOR_PALETTE for new types — D-42-07)
 * - ConfirmDialog for destructive deletes (D-42-04 — optional, included)
 * - Esc key closes the panel (keyboard a11y)
 */
export function LayersPanel({
  universeId,
  visible,
  onToggle,
  onRequestColorPick,
}: LayersPanelProps) {
  // Only fetch when the panel is actually shown — in share mode the editor mounts
  // this panel with visible=false, and fetching there 404s on the share seam (WR-03).
  const { data: layers = [] } = useMapLayers(universeId, { enabled: visible });

  const createLayer = useCreateMapLayer(universeId);
  const updateLayer = useUpdateMapLayer(universeId);
  const deleteLayer = useDeleteMapLayer(universeId);
  const createType = useCreateTerrainType(universeId);
  const updateType = useUpdateTerrainType(universeId);
  const deleteType = useDeleteTerrainType(universeId);
  const addBiomes = useAddBiomesPreset(universeId);
  const addElevation = useAddElevationPreset(universeId);

  // ── Inline rename state ────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renameError, setRenameError] = useState('');

  // ── Expand/collapse per layer ──────────────────────────────────────────────
  const [expandedLayerIds, setExpandedLayerIds] = useState<Set<string>>(new Set());

  // ── Per-viewer visibility (local only — no API call) ──────────────────────
  const [hiddenLayerIds, setHiddenLayerIds] = useState<Set<string>>(new Set());

  // ── Delete confirm dialog ──────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: 'layer' | 'type';
    id: string;
    layerId?: string;
    name: string;
  } | null>(null);

  // ── Esc-key close ─────────────────────────────────────────────────────────
  const stableOnToggle = useCallback(onToggle, [onToggle]);
  useEffect(() => {
    if (!visible) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stableOnToggle();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [visible, stableOnToggle]);

  // ── Inline rename handlers ─────────────────────────────────────────────────
  const startRename = (id: string, current: string) => {
    setEditingId(id);
    setDraftName(current);
    setRenameError('');
  };

  const commitRename = (
    kind: 'layer' | 'type',
    id: string,
    layerId?: string,
  ) => {
    if (!draftName.trim()) {
      setRenameError('Name cannot be empty');
      return;
    }
    setRenameError('');
    if (kind === 'layer') {
      updateLayer.mutate({ layerId: id, name: draftName.trim() });
    } else if (layerId) {
      updateType.mutate({ layerId, typeId: id, name: draftName.trim() });
    }
    setEditingId(null);
  };

  const handleRenameKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    kind: 'layer' | 'type',
    id: string,
    layerId?: string,
  ) => {
    if (e.key === 'Enter') commitRename(kind, id, layerId);
    if (e.key === 'Escape') {
      setEditingId(null);
      setRenameError('');
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const toggleExpand = (layerId: string) => {
    setExpandedLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const toggleVisibility = (layerId: string) => {
    setHiddenLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const nextColor = (layer: MapLayer) => {
    const count = layer.terrainTypes?.length ?? 0;
    return MAP_COLOR_PALETTE[count % MAP_COLOR_PALETTE.length];
  };

  const handleAddLayer = () => {
    createLayer.mutate({ name: 'New layer' });
  };

  const handleAddType = (layer: MapLayer) => {
    createType.mutate({
      layerId: layer.id,
      name: 'New type',
      color: nextColor(layer),
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    if (deleteTarget.kind === 'layer') {
      deleteLayer.mutate(deleteTarget.id);
    } else if (deleteTarget.layerId) {
      deleteType.mutate({ layerId: deleteTarget.layerId, typeId: deleteTarget.id });
    }
    setDeleteTarget(null);
  };

  const handleReorderType = (
    layer: MapLayer,
    type: TerrainType,
    direction: 'up' | 'down',
  ) => {
    const types = [...(layer.terrainTypes ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder,
    );
    const idx = types.findIndex((t) => t.id === type.id);
    if (idx < 0) return;
    const neighborIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (neighborIdx < 0 || neighborIdx >= types.length) return;
    const neighbor = types[neighborIdx];
    // Swap sort_orders
    updateType.mutate({
      layerId: layer.id,
      typeId: type.id,
      sortOrder: neighbor.sortOrder,
    });
    updateType.mutate({
      layerId: layer.id,
      typeId: neighbor.id,
      sortOrder: type.sortOrder,
    });
  };

  const handleSwatchClick = (type: TerrainType, layer: MapLayer) => {
    if (!onRequestColorPick) return;
    onRequestColorPick(type.color, (hex) => {
      updateType.mutate({ layerId: layer.id, typeId: type.id, color: hex });
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    // Pointer-events-none wrapper so d3-zoom on MapCanvas is never blocked.
    // CRITICAL: this class must NOT be removed — same guard as MapLegend.
    <div className="pointer-events-none absolute inset-0">
      {visible && (
        <div
          role="region"
          aria-label="Layers panel"
          className="pointer-events-auto absolute top-14 right-3 z-50 w-64 max-h-[70vh] overflow-y-auto rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Layers
            </span>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Close layers panel"
              className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
            >
              ×
            </button>
          </div>

          {/* World-wide scope banner (D-42-04) — persistent, no dismiss */}
          <div
            role="note"
            className="bg-neutral-100 dark:bg-neutral-800 px-4 py-2 text-xs text-neutral-500 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700"
          >
            World-wide — changes apply to all maps in this universe
          </div>

          {/* Empty state + preset CTAs (shown only when no layers exist) */}
          {layers.length === 0 ? (
            <div className="px-4 py-4">
              <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                No layers yet
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
                Define thematic layers (Biomes, Elevation&hellip;) and their terrain
                types. Start with a preset or add a layer.
              </p>
              <p className="text-xs font-semibold text-neutral-500 dark:text-neutral-400 mb-2">
                Start with a preset:
              </p>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => addBiomes.mutate()}
                  disabled={addBiomes.isPending}
                  className="bg-[color:var(--color-accent)] text-white text-xs px-4 py-2 rounded-md hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 min-h-[44px] disabled:opacity-60"
                >
                  Add starter Biomes
                </button>
                <button
                  type="button"
                  onClick={() => addElevation.mutate()}
                  disabled={addElevation.isPending}
                  className="bg-[color:var(--color-accent)] text-white text-xs px-4 py-2 rounded-md hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 min-h-[44px] disabled:opacity-60"
                >
                  Add starter Elevation
                </button>
              </div>
            </div>
          ) : (
            /* Layer list */
            <ul role="list">
              {[...layers]
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((layer) => {
                  const isExpanded = expandedLayerIds.has(layer.id);
                  const isVisible = !hiddenLayerIds.has(layer.id);
                  const isEditingLayer = editingId === layer.id;
                  const sortedTypes = [...(layer.terrainTypes ?? [])].sort(
                    (a, b) => a.sortOrder - b.sortOrder,
                  );

                  return (
                    <li key={layer.id} className="border-b border-neutral-100 dark:border-neutral-800">
                      {/* Layer row */}
                      <div className="flex items-center gap-2 px-4 py-2">
                        {/* Expand/collapse chevron */}
                        <button
                          type="button"
                          onClick={() => toggleExpand(layer.id)}
                          aria-label={isExpanded ? `Collapse ${layer.name}` : `Expand ${layer.name}`}
                          className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-1 text-xs min-h-[44px] min-w-[20px] flex items-center justify-center"
                        >
                          {isExpanded ? '▾' : '▸'}
                        </button>

                        {/* Inline-editable layer name */}
                        {isEditingLayer ? (
                          <div className="flex-1 min-w-0">
                            <input
                              type="text"
                              value={draftName}
                              onChange={(e) => {
                                setDraftName(e.target.value);
                                setRenameError('');
                              }}
                              onBlur={() => commitRename('layer', layer.id)}
                              onKeyDown={(e) => handleRenameKeyDown(e, 'layer', layer.id)}
                              autoFocus
                              aria-label="Edit layer name"
                              className="w-full text-sm border border-[color:var(--color-accent)] rounded px-1 py-0.5 outline-none bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2"
                            />
                            {renameError && (
                              <p className="text-red-600 text-xs mt-0.5">{renameError}</p>
                            )}
                          </div>
                        ) : (
                          <div className="flex-1 min-w-0 flex items-center gap-1">
                            <button
                              type="button"
                              onDoubleClick={() => startRename(layer.id, layer.name)}
                              className="flex-1 min-w-0 truncate text-sm text-left text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 focus-visible:outline-none focus-visible:underline"
                              title="Double-click to rename"
                            >
                              {layer.name}
                            </button>
                            {layer.ordered && (
                              <span className="text-xs bg-neutral-100 dark:bg-neutral-800 px-1 rounded text-neutral-500 flex-shrink-0">
                                ranked
                              </span>
                            )}
                          </div>
                        )}

                        {/* Visibility checkbox (local-only state — NO API call) */}
                        <input
                          type="checkbox"
                          checked={isVisible}
                          onChange={() => toggleVisibility(layer.id)}
                          aria-label={`Toggle ${layer.name} visibility`}
                          className="focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 min-h-[44px]"
                          title="Visible"
                        />

                        {/* Delete layer button */}
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              kind: 'layer',
                              id: layer.id,
                              name: layer.name,
                            })
                          }
                          aria-label={`Delete layer ${layer.name}`}
                          className="text-red-600 text-xs hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 min-h-[44px] min-w-[20px] flex items-center justify-center"
                        >
                          ×
                        </button>
                      </div>

                      {/* Opacity slider (PATCH defaultOpacity on change) */}
                      <div className="px-4 pb-2 flex items-center gap-2">
                        <label
                          htmlFor={`opacity-${layer.id}`}
                          className="text-xs text-neutral-500 flex-shrink-0"
                        >
                          Default opacity
                        </label>
                        <input
                          id={`opacity-${layer.id}`}
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          defaultValue={layer.defaultOpacity}
                          aria-label={`Default opacity for ${layer.name}`}
                          aria-valuetext={`${Math.round(layer.defaultOpacity * 100)}%`}
                          onBlur={(e) =>
                            updateLayer.mutate({
                              layerId: layer.id,
                              defaultOpacity: parseFloat(e.target.value),
                            })
                          }
                          className="w-16 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2"
                        />
                      </div>

                      {/* Expanded: terrain type list */}
                      {isExpanded && (
                        <div className="pb-1">
                          <ul role="list">
                            {sortedTypes.map((type, idx) => {
                              const isFirst = idx === 0;
                              const isLast = idx === sortedTypes.length - 1;
                              const isEditingType = editingId === type.id;

                              return (
                                <li
                                  key={type.id}
                                  className="flex items-center gap-2 px-4 py-1"
                                >
                                  {/* Color swatch (click → color picker via callback) */}
                                  <button
                                    type="button"
                                    onClick={() => handleSwatchClick(type, layer)}
                                    aria-label={`Change color for ${type.name} — current: ${type.color}`}
                                    title={`Change color for ${type.name}`}
                                    className="w-4 h-4 rounded-full flex-shrink-0 border border-neutral-300 dark:border-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 min-h-[44px] min-w-[44px]"
                                    style={{ backgroundColor: type.color }}
                                  />

                                  {/* Inline-editable type name */}
                                  {isEditingType ? (
                                    <div className="flex-1 min-w-0">
                                      <input
                                        type="text"
                                        value={draftName}
                                        onChange={(e) => {
                                          setDraftName(e.target.value);
                                          setRenameError('');
                                        }}
                                        onBlur={() =>
                                          commitRename('type', type.id, layer.id)
                                        }
                                        onKeyDown={(e) =>
                                          handleRenameKeyDown(e, 'type', type.id, layer.id)
                                        }
                                        autoFocus
                                        aria-label="Edit terrain type name"
                                        className="w-full text-xs border border-[color:var(--color-accent)] rounded px-1 py-0.5 outline-none bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
                                      />
                                      {renameError && (
                                        <p className="text-red-600 text-xs mt-0.5">
                                          {renameError}
                                        </p>
                                      )}
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onDoubleClick={() => startRename(type.id, type.name)}
                                      className="flex-1 min-w-0 truncate text-xs text-left text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 focus-visible:outline-none focus-visible:underline"
                                      title="Double-click to rename"
                                    >
                                      {type.name}
                                    </button>
                                  )}

                                  {/* Ordered-layer extras: up/down reorder + height-range label */}
                                  {layer.ordered && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (!isFirst)
                                            handleReorderType(layer, type, 'up');
                                        }}
                                        aria-label={`Move ${type.name} up`}
                                        aria-disabled={isFirst ? 'true' : 'false'}
                                        disabled={isFirst}
                                        className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-1 min-h-[44px] min-w-[20px] flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                                      >
                                        ▲
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          if (!isLast)
                                            handleReorderType(layer, type, 'down');
                                        }}
                                        aria-label={`Move ${type.name} down`}
                                        aria-disabled={isLast ? 'true' : 'false'}
                                        disabled={isLast}
                                        className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-1 min-h-[44px] min-w-[20px] flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                                      >
                                        ▼
                                      </button>

                                      {/* Height-range label (free-text, autosave on blur) */}
                                      <input
                                        type="text"
                                        defaultValue={type.label ?? ''}
                                        placeholder="e.g. 500–1500 m"
                                        aria-label={`Height range for ${type.name}`}
                                        onBlur={(e) => {
                                          const val = e.target.value.trim() || null;
                                          updateType.mutate({
                                            layerId: layer.id,
                                            typeId: type.id,
                                            label: val,
                                          });
                                        }}
                                        className="w-20 text-xs border border-neutral-200 dark:border-neutral-700 rounded px-1 py-0.5 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 placeholder-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2"
                                      />
                                    </>
                                  )}

                                  {/* Delete terrain-type button */}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setDeleteTarget({
                                        kind: 'type',
                                        id: type.id,
                                        layerId: layer.id,
                                        name: type.name,
                                      })
                                    }
                                    aria-label={`Delete terrain type ${type.name}`}
                                    className="text-red-600 text-xs hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-1 min-h-[44px] min-w-[20px] flex items-center justify-center"
                                  >
                                    ×
                                  </button>
                                </li>
                              );
                            })}
                          </ul>

                          {/* Add terrain type */}
                          <button
                            type="button"
                            onClick={() => handleAddType(layer)}
                            className="text-xs text-[color:var(--color-accent)] hover:underline px-4 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2"
                          >
                            + Add type
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
          )}

          {/* Add layer button (shown when layers exist too) */}
          {layers.length > 0 && (
            <button
              type="button"
              onClick={handleAddLayer}
              className="text-xs text-[color:var(--color-accent)] hover:underline px-4 py-2 w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 min-h-[44px]"
            >
              + Add layer
            </button>
          )}
        </div>
      )}

      {/* Destructive delete confirm dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={
          deleteTarget?.kind === 'layer'
            ? `Delete layer "${deleteTarget.name}"?`
            : `Delete terrain type "${deleteTarget?.name}"?`
        }
        body={
          deleteTarget?.kind === 'layer'
            ? 'All terrain types in this layer will also be deleted. This cannot be undone.'
            : 'Any regions tagged with this type will have their terrain type cleared.'
        }
        confirmLabel={deleteTarget?.kind === 'layer' ? 'Delete layer' : 'Delete type'}
        destructive
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}
