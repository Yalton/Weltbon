import { useState } from 'react';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import { GlyphIcon } from '../lib/mapGlyphs';
import type { MapPin, MapRegion, TerrainAreaRegion } from '../hooks/useMap';
import type { MapLayer } from '../hooks/useMapLayers';


export interface MapLegendProps {
  pins: MapPin[];
  regions: MapRegion[];
  legendLabels: Record<string, string> | null;
  onRenameLabel: (key: string, value: string) => void;
  visible: boolean;
  onToggle: () => void;

  layers?: MapLayer[];
  terrainAreas?: TerrainAreaRegion[];
  layerViewerState?: Record<string, { visible: boolean; opacity: number }>;
}


interface LegendRow {
  key: string;
  color: string;
  icon: string | null;
  defaultLabel: string;
}

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
    const icon = null;
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
    <div className="pointer-events-none absolute inset-0">
      {visible && (
        <div
          role="region"
          aria-label="Map legend"
          className="pointer-events-auto absolute top-14 right-3 z-50 w-48 max-h-64 overflow-y-auto rounded-md border border-line-strong bg-raised shadow-lg"
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


          {layers && terrainAreas && layerViewerState &&
            [...layers]
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((layer) => {
                // Gate: hidden layer drops its block entirely (D-43-06).
                if (layerViewerState[layer.id]?.visible === false) return null;

                const presentTypeIds = new Set(
                  terrainAreas
                    .filter((a) => a.layerId === layer.id)
                    .map((a) => a.terrainTypeId)
                );

                const presentTypes = (layer.terrainTypes ?? [])
                  .filter((t) => presentTypeIds.has(t.id))
                  .sort((a, b) => a.sortOrder - b.sortOrder);

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
