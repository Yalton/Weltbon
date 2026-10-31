export interface MapZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitReset: () => void;
  gridVisible?: boolean;
  onToggleGrid?: () => void;
}

export function MapZoomControls({
  onZoomIn,
  onZoomOut,
  onFitReset,
  gridVisible = false,
  onToggleGrid,
}: MapZoomControlsProps) {
  // Inactive button style — matches MapToolbar.tsx border-only button (lines 80, 96, 106, 121, 135)
  const inactiveBtn =
    'rounded-md text-sm w-8 h-8 flex items-center justify-center ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 ' +
    'border border-line-strong text-ink ' +
    ' hover:bg-white/5';

  // Active button style (accent-fill) — used for the grid toggle when active
  const activeBtn =
    'rounded-md text-sm w-8 h-8 flex items-center justify-center ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 ' +
    'btn-accent';

  return (
    <div
      className="absolute right-4 bottom-4 z-10 flex flex-col items-center gap-1 rounded-md border border-line-strong bg-raised p-1 shadow-sm"
      role="group"
      aria-label="Map zoom controls"
    >
      {/* Zoom in */}
      <button
        type="button"
        onClick={onZoomIn}
        className={inactiveBtn}
        aria-label="Zoom in"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M7 1v6H1v2h6v6h2V9h6V7H9V1H7z"/>
        </svg>
      </button>

      {/* Zoom out */}
      <button
        type="button"
        onClick={onZoomOut}
        className={inactiveBtn}
        aria-label="Zoom out"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M1 7h14v2H1z"/>
        </svg>
      </button>

      {/* Divider */}
      <div className="w-4 h-px bg-white/10 my-0.5" aria-hidden />

      {/* Fit/reset — returns the viewport to the initial fit-to-image transform */}
      <button
        type="button"
        onClick={onFitReset}
        className={inactiveBtn}
        aria-label="Fit map to view"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <path d="M1 1h5v2H3v3H1V1zm9 0h5v5h-2V3h-3V1zM1 10h2v3h3v2H1v-5zm12 3h-3v2h5v-5h-2v3z"/>
        </svg>
      </button>

      {/* Optional grid toggle — only rendered when onToggleGrid is provided */}
      {onToggleGrid && (
        <>
          <div className="w-4 h-px bg-white/10 my-0.5" aria-hidden />
          <button
            type="button"
            onClick={onToggleGrid}
            aria-pressed={gridVisible}
            className={gridVisible ? activeBtn : inactiveBtn}
            aria-label={gridVisible ? 'Hide grid' : 'Show grid'}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M0 0h16v16H0V0zm2 2v12h12V2H2zm4 0v12H6V2h2zm4 0v12h-2V2h2zM2 6h12v2H2V6zm0 4h12v-2H2v2z"/>
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
