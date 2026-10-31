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
  mapName: string;
  addPinMode?: boolean;
  onToggleAddPinMode?: () => void;
  drawRegionMode?: boolean;
  onToggleDrawRegionMode?: () => void;
  drawRouteMode?: boolean;
  onToggleDrawRouteMode?: () => void;
  onChangeImage?: () => void;
  legendVisible?: boolean;
  onToggleLegend?: () => void;
  layersPanelVisible?: boolean;
  onToggleLayersPanel?: () => void;

  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  hasBreadcrumb?: boolean;
}

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
  hasBreadcrumb,
}: MapToolbarProps) {
  const hasMutationButtons = !!(onToggleAddPinMode || onToggleDrawRegionMode || onChangeImage || onToggleLegend || onToggleLayersPanel);

  return (
    <div className={`absolute left-4 ${hasBreadcrumb ? 'top-16' : 'top-4'} z-10 flex flex-wrap items-center gap-2 rounded-md border border-line-strong bg-raised px-3 py-2 shadow-sm max-w-[calc(100vw-2rem)]`}>
      {/* Read-only map name */}
      <span className="text-sm font-semibold text-ink truncate max-w-[160px]">
        {mapName}
      </span>

      {/* Mutation-button divider — only shown when any mutation button is present */}
      {hasMutationButtons && (
        <div className="w-px h-4 bg-white/10 mx-1" aria-hidden />
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
              ? 'btn-accent'
              : 'border border-line-strong text-ink hover:bg-white/5',
          ].join(' ')}
        >
          {addPinMode ? COPY.addingPins : COPY.addPin}
        </button>
      )}


      {onToggleDrawRegionMode && (
        <button
          type="button"
          onClick={onToggleDrawRegionMode}
          aria-pressed={drawRegionMode}
          className={[
            'rounded-md text-sm px-3 py-2',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2',
            drawRegionMode
              ? 'btn-accent'
              : 'border border-line-strong text-ink hover:bg-white/5',
          ].join(' ')}
        >
          {drawRegionMode ? COPY.drawingRegion : COPY.drawRegion}
        </button>
      )}


      {onToggleDrawRouteMode && (
        <button
          type="button"
          onClick={onToggleDrawRouteMode}
          aria-pressed={drawRouteMode}
          className={[
            'rounded-md text-sm px-3 py-2',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2',
            drawRouteMode
              ? 'btn-accent'
              : 'border border-line-strong text-ink hover:bg-white/5',
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
          className="rounded-md border border-line-strong text-ink text-sm px-3 py-2 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
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
              ? 'btn-accent'
              : 'border border-line-strong text-ink hover:bg-white/5',
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
              ? 'btn-accent'
              : 'border border-line-strong text-ink hover:bg-white/5',
          ].join(' ')}
        >
          {COPY.layers}
        </button>
      )}


      {onSearchQueryChange && (
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery ?? ''}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder={COPY.searchPlaceholder}
          aria-label="Search map items"
          className="rounded-md border border-line-strong text-sm px-3 py-2 bg-panel text-ink placeholder:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] w-40"
        />
      )}
    </div>
  );
}
