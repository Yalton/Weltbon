import type React from 'react';

// Locked copy (UI-SPEC "Map Editor" + Copywriting Contract — toolbar section).
const COPY = {
  addPin: 'Add pin',
  addingPins: 'Adding pins...',
  changeImage: 'Change image',
  drawRegion: 'Draw region',
  drawingRegion: 'Drawing region...',
  drawRoute: 'Draw route',
  drawingRoute: 'Drawing route...',
  legend: 'Legend',
  layers: 'Layers',
  searchPlaceholder: 'Search map...',
} as const;

export interface MapToolbarProps {
  /** The map's display name — shown read-only in the toolbar. */
  mapName: string;
  /** Whether the canvas is in add-pin mode. */
  addPinMode?: boolean;
  /** Toggle add-pin mode on/off. Only shown when provided. */
  onToggleAddPinMode?: () => void;
  /** Whether the canvas is in draw-region mode (D-04). */
  drawRegionMode?: boolean;
  /** Toggle draw-region mode on/off. Only shown when provided. */
  onToggleDrawRegionMode?: () => void;
  /** Whether the canvas is in draw-route mode (ROUTE-01, Plan 07). */
  drawRouteMode?: boolean;
  /** Toggle draw-route mode on/off. */
  onToggleDrawRouteMode?: () => void;
  /** Open the Change image picker. Only shown when provided. */
  onChangeImage?: () => void;
  /** Whether the legend panel is visible. */
  legendVisible?: boolean;
  /** Toggle legend panel. */
  onToggleLegend?: () => void;
  /** Whether the layers panel is visible. */
  layersPanelVisible?: boolean;
  /** Toggle layers panel. */
  onToggleLayersPanel?: () => void;

  // ── Phase 52 SEARCH-01: controlled search input (D-04) ─────────────────────
  /** Value of the search input (controlled). Rendered in BOTH editor and share view (D-04). */
  searchQuery?: string;
  /** Called when the search input value changes. Only rendered when provided. */
  onSearchQueryChange?: (q: string) => void;
  /** Ref forwarded to the search `<input>` element for programmatic focus (/ shortcut). */
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

/**
 * Floating top-left toolbar overlay for MapEditor.
 *
 * Simplified version of DiagramToolbar — no undo/redo, no align/distribute,
 * no export, no auto-layout. Contains only:
 *   - "Add pin" mode toggle (accent fill when active) — shown when onToggleAddPinMode provided
 *   - "Draw region" mode toggle (accent fill when active) — shown when onToggleDrawRegionMode provided
 *   - "Change image" action (border style) — shown when onChangeImage provided
 *   - "Legend" toggle button (border style) — shown when onToggleLegend provided
 *   - Read-only map name (text-sm font-semibold)
 *   - Search input (always shown when onSearchQueryChange provided) — Phase 52 SEARCH-01 (D-04)
 *
 * Phase 52 SEARCH-01 (D-04): The search input renders in BOTH editor and share view.
 * Mutation buttons (Add pin, Draw region, etc.) are gated on their callback props so they
 * are absent in share mode (where only the search input and map name are passed).
 *
 * Positioning: absolute left-4 top-4 z-10, mirroring DiagramToolbar's
 * floating overlay but anchored top-left (not top-right).
 */
export function MapToolbar({
  mapName,
  addPinMode,
  onToggleAddPinMode,
  drawRegionMode,
  onToggleDrawRegionMode,
  drawRouteMode,
  onToggleDrawRouteMode,
  onChangeImage,
  legendVisible,
  onToggleLegend,
  layersPanelVisible,
  onToggleLayersPanel,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
}: MapToolbarProps) {
  // Whether any mutation button is present — used to decide if a divider is needed
  // before the search input.
  const hasMutationButtons = !!(onToggleAddPinMode || onToggleDrawRegionMode || onChangeImage || onToggleLegend || onToggleLayersPanel);

  return (
    <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm px-3 py-2 shadow-sm max-w-[calc(100vw-2rem)]">
      {/* Read-only map name */}
      <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate max-w-[160px]">
        {mapName}
      </span>

      {/* Mutation-button divider — only shown when any mutation button is present */}
      {hasMutationButtons && (
        <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-1" aria-hidden />
      )}

      {/* Add pin mode toggle — accent fill when active, border when inactive.
          Only shown when onToggleAddPinMode is provided (absent in share mode). */}
      {onToggleAddPinMode && (
        <button
          type="button"
          onClick={onToggleAddPinMode}
          aria-pressed={addPinMode}
          className={[
            'rounded-md text-sm px-3 py-2',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2',
            addPinMode
              ? 'bg-[color:var(--color-accent)] text-white'
              : 'border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800',
          ].join(' ')}
        >
          {addPinMode ? COPY.addingPins : COPY.addPin}
        </button>
      )}

      {/* Draw region mode toggle — Phase 40 D-04.
          Only shown when onToggleDrawRegionMode is provided (absent in share mode). */}
      {onToggleDrawRegionMode && (
        <button
          type="button"
          onClick={onToggleDrawRegionMode}
          aria-pressed={drawRegionMode}
          className={[
            'rounded-md text-sm px-3 py-2',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2',
            drawRegionMode
              ? 'bg-[color:var(--color-accent)] text-white'
              : 'border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800',
          ].join(' ')}
        >
          {drawRegionMode ? COPY.drawingRegion : COPY.drawRegion}
        </button>
      )}

      {/* Draw route mode toggle — Phase 51 ROUTE-01 (Plan 07). Only shown when onToggleDrawRouteMode provided. */}
      {onToggleDrawRouteMode && (
        <button
          type="button"
          onClick={onToggleDrawRouteMode}
          aria-pressed={drawRouteMode}
          className={[
            'rounded-md text-sm px-3 py-2',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2',
            drawRouteMode
              ? 'bg-[color:var(--color-accent)] text-white'
              : 'border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800',
          ].join(' ')}
        >
          {drawRouteMode ? COPY.drawingRoute : COPY.drawRoute}
        </button>
      )}

      {/* Change image — border style. Only shown when onChangeImage is provided (absent in share mode). */}
      {onChangeImage && (
        <button
          type="button"
          onClick={onChangeImage}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        >
          {COPY.changeImage}
        </button>
      )}

      {/* Legend toggle — only shown when onToggleLegend is provided */}
      {onToggleLegend && (
        <button
          type="button"
          onClick={onToggleLegend}
          aria-pressed={legendVisible}
          className={[
            'rounded-md text-sm px-3 py-2',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2',
            legendVisible
              ? 'bg-[color:var(--color-accent)] text-white'
              : 'border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800',
          ].join(' ')}
        >
          {COPY.legend}
        </button>
      )}

      {/* Layers toggle — only shown when onToggleLayersPanel is provided */}
      {onToggleLayersPanel && (
        <button
          type="button"
          onClick={onToggleLayersPanel}
          aria-pressed={layersPanelVisible}
          className={[
            'rounded-md text-sm px-3 py-2',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2',
            layersPanelVisible
              ? 'bg-[color:var(--color-accent)] text-white'
              : 'border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800',
          ].join(' ')}
        >
          {COPY.layers}
        </button>
      )}

      {/* Phase 52 SEARCH-01: Controlled search input (D-04).
          Rendered OUTSIDE the mutation-button gate — visible in BOTH editor and share view.
          Only shown when onSearchQueryChange is provided (D-04, plan task 2).
          Glassy on-theme chrome matching existing toolbar buttons. Width w-40 (160px) fits
          typical toolbar without overflow; placeholder text guides user to type to search.
          CRITICAL: no d3 datum handler — React onChange only
          (memory: timeline-pins-react-rendered-no-d3-datum). */}
      {onSearchQueryChange && (
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery ?? ''}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder={COPY.searchPlaceholder}
          aria-label="Search map items"
          className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-2 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] w-40"
        />
      )}
    </div>
  );
}
