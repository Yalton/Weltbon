import { useState } from 'react';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import { GlyphIcon } from '../lib/mapGlyphs';
import type { MapPin, MapRegion, TerrainAreaRegion } from '../hooks/useMap';
import type { MapLayer } from '../hooks/useMapLayers';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MapLegendProps {
  /** Enriched pins (with entryType for color fallback). */
  pins: MapPin[];
  /** Regions (with optional color). */
  regions: MapRegion[];
  /**
   * Persisted caption overrides keyed by "{color}:{icon|''}".
   * Provided by map.legendLabels JSON field (parsed object or null).
   */
  legendLabels: Record<string, string> | null;
  /** Called when the user renames a legend row caption. */
  onRenameLabel: (key: string, value: string) => void;
  /** Whether the panel is visible. */
  visible: boolean;
  /** Toggle panel open/closed. */
  onToggle: () => void;

  // Phase 43 TERRAIN-05: optional props for per-layer terrain legend blocks.
  // When all three are present, append a legend block per visible layer that has
  // at least one terrain area painted on the current map.
  /** All map layers for this universe (with terrainTypes populated). */
  layers?: MapLayer[];
  /** All terrain areas on the current map (terrainTypeId non-null). */
  terrainAreas?: TerrainAreaRegion[];
  /** Per-viewer layer visibility/opacity (from localStorage or MapEditor state). */
  layerViewerState?: Record<string, { visible: boolean; opacity: number }>;
}

// ─── Row derivation ───────────────────────────────────────────────────────────

interface LegendRow {
  /** Composite key: "{color}:{icon}" or "{color}:" for regions (no icon). */
  key: string;
  color: string;
  /** Glyph key from MAP_GLYPHS, or null if this row has no icon. */
  icon: string | null;
  /** Default caption = entry type name; overridden by legendLabels[key]. */
  defaultLabel: string;
}

/**
 * Auto-derives one row per distinct (color, icon) combination across all pins
 * and regions (D-03). Entries with no color fall back to entryTypeHexColor.
 * Regions never have icons this phase (D-02).
 *
 * Key difference from RelationLegend.deriveRows: no per-row color editor
 * (D-03 — color is edited on the element itself via the context menu picker).
 */
function deriveRows(pins: MapPin[], regions: MapRegion[]): LegendRow[] {
  const seen = new Set<string>();
  const rows: LegendRow[] = [];

  for (const pin of pins) {
    const color = pin.color ?? entryTypeHexColor(pin.entryType ?? 'concept');
    const icon = pin.icon ?? null;
    const key = `${color}:${icon ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      color,
      icon,
      defaultLabel: pin.entryType
        ? pin.entryType.charAt(0).toUpperCase() + pin.entryType.slice(1)
        : 'Pin',
    });
  }

  for (const region of regions) {
    const color = region.color ?? '#6b7280'; // neutral fallback for standalone regions
    const icon = null; // regions have no icon this phase (D-02)
    const key = `${color}:`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      color,
      icon,
      defaultLabel: region.name || 'Region',
    });
  }

  return rows;
}

// ─── MapLegend ────────────────────────────────────────────────────────────────

/**
 * Auto-derived map legend panel (D-03).
 *
 * One row per distinct (color, icon) combination across pins + regions.
 * Captions are renamable inline; overrides persist via onRenameLabel.
 *
 * CRITICAL: outer wrapper uses pointer-events-none so d3-zoom is never blocked.
 * Only the panel itself (pointer-events-auto) intercepts pointer events.
 *
 * Key differences from RelationLegend:
 * - NO onColorChange / no per-row color editor (D-03).
 * - Icon glyph swatch added via inline GlyphIcon (D-02).
 * - Derives rows from pins + regions instead of edges.
 * - Caption overrides from legendLabels[key] not from linkType registry.
 */
export function MapLegend({
  pins,
  regions,
  legendLabels,
  onRenameLabel,
  visible,
  onToggle,
  layers,
  terrainAreas,
  layerViewerState,
}: MapLegendProps) {
  const rows = deriveRows(pins, regions);

  // Track which row is being renamed (by key).
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');

  const startRename = (key: string, currentLabel: string) => {
    setEditingKey(key);
    setDraftLabel(currentLabel);
  };

  const commitRename = (key: string) => {
    if (draftLabel.trim()) {
      onRenameLabel(key, draftLabel.trim());
    }
    setEditingKey(null);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, key: string) => {
    if (e.key === 'Enter') commitRename(key);
    if (e.key === 'Escape') setEditingKey(null);
  };

  return (
    // Pointer-events-none wrapper so the d3-zoom SVG below is never blocked.
    // Same overlay guard as RelationLegend (lines 104–107).
    <div className="pointer-events-none absolute inset-0">
      {visible && (
        <div
          role="region"
          aria-label="Map legend"
          className="pointer-events-auto absolute top-14 right-3 z-50 w-48 max-h-64 overflow-y-auto rounded-md border border-neutral-200 bg-white/90 backdrop-blur-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-900/90"
        >
          {/* Panel header */}
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Legend
            </span>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Close legend"
              className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              ×
            </button>
          </div>

          {rows.length === 0 ? (
            <p className="px-3 py-2 text-xs text-neutral-400">
              No pins or regions yet.
            </p>
          ) : (
            <ul role="list" className="pb-2">
              {rows.map((row) => {
                const label = legendLabels?.[row.key] ?? row.defaultLabel;
                const isEditing = editingKey === row.key;

                return (
                  <li key={row.key} className="flex items-center gap-2 px-3 py-1">
                    {/* Color swatch — NO onClick editor (D-03) */}
                    <span
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: row.color }}
                      aria-label={`Color: ${row.color}`}
                    />

                    {/* Optional glyph icon (pins only, D-02) */}
                    {row.icon && (
                      <GlyphIcon glyph={row.icon} size={12} color={row.color} />
                    )}

                    {/* Renamable label — click to start editing */}
                    {isEditing ? (
                      <input
                        type="text"
                        value={draftLabel}
                        onChange={(e) => setDraftLabel(e.target.value)}
                        onBlur={() => commitRename(row.key)}
                        onKeyDown={(e) => handleInputKeyDown(e, row.key)}
                        className="flex-1 min-w-0 text-xs border border-[color:var(--color-accent)] rounded px-1 py-0.5 outline-none bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
                        autoFocus
                        aria-label="Edit legend caption"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startRename(row.key, label)}
                        className="flex-1 min-w-0 truncate text-xs text-left text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-neutral-100 focus-visible:outline-none focus-visible:underline"
                        title="Click to rename"
                      >
                        {label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Phase 43 TERRAIN-05: per-layer terrain legend blocks.
              Rendered only when all three optional props are provided.
              Each visible layer with at least one terrain area present on this
              map renders a block: a heading (layer name) + one row per present
              type in sort_order (reads as a ranked ramp for ordered layers).
              Hidden layers and absent types are omitted (D-43-06). */}
          {layers && terrainAreas && layerViewerState &&
            [...layers]
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((layer) => {
                // Gate: hidden layer drops its block entirely (D-43-06).
                if (layerViewerState[layer.id]?.visible === false) return null;

                // Derive present type IDs: only terrain types actually used on
                // THIS map (not the full layer palette).
                const presentTypeIds = new Set(
                  terrainAreas
                    .filter((a) => a.layerId === layer.id)
                    .map((a) => a.terrainTypeId)
                );

                // Filtered + sorted terrain types (present on this map only).
                const presentTypes = (layer.terrainTypes ?? [])
                  .filter((t) => presentTypeIds.has(t.id))
                  .sort((a, b) => a.sortOrder - b.sortOrder);

                // Gate: no present types → render nothing for this layer.
                if (presentTypes.length === 0) return null;

                return (
                  <div
                    key={layer.id}
                    className="border-t border-neutral-100 dark:border-neutral-800 pt-2 pb-1 px-3 mt-2"
                  >
                    {/* Block heading — matches the "Legend" heading style (L144). */}
                    <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">
                      {layer.name}
                    </p>
                    <ul role="list">
                      {presentTypes.map((type) => (
                        <li key={type.id} className="flex items-center gap-2 py-0.5">
                          {/* Passive color swatch — decorative, not interactive. */}
                          <span
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: type.color }}
                            aria-hidden="true"
                          />
                          <span className="text-xs text-neutral-700 dark:text-neutral-300">
                            {type.name}
                            {/* Ordered layers: append band label in parentheses when set.
                                sort_order ascending renders as a ranked ramp top-to-bottom. */}
                            {layer.ordered && type.label && (
                              <span className="text-neutral-500"> ({type.label})</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })
          }
        </div>
      )}
    </div>
  );
}
