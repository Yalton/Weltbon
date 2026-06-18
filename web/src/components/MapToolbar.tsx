// Locked copy (UI-SPEC "Map Editor" + Copywriting Contract — toolbar section).
const COPY = {
  addPin: 'Add pin',
  addingPins: 'Adding pins...',
  changeImage: 'Change image',
} as const;

export interface MapToolbarProps {
  /** The map's display name — shown read-only in the toolbar. */
  mapName: string;
  /** Whether the canvas is in add-pin mode. */
  addPinMode: boolean;
  /** Toggle add-pin mode on/off. */
  onToggleAddPinMode: () => void;
  /** Open the Change image picker. */
  onChangeImage: () => void;
}

/**
 * Floating top-left toolbar overlay for MapEditor.
 *
 * Simplified version of DiagramToolbar — no undo/redo, no align/distribute,
 * no export, no auto-layout. Contains only:
 *   - "Add pin" mode toggle (accent fill when active)
 *   - "Change image" action (border style)
 *   - Read-only map name (text-sm font-semibold)
 *
 * Positioning: absolute left-4 top-4 z-10, mirroring DiagramToolbar's
 * floating overlay but anchored top-left (not top-right).
 */
export function MapToolbar({
  mapName,
  addPinMode,
  onToggleAddPinMode,
  onChangeImage,
}: MapToolbarProps) {
  return (
    <div className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm px-3 py-2 shadow-sm">
      {/* Read-only map name */}
      <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate max-w-[160px]">
        {mapName}
      </span>

      <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-1" aria-hidden />

      {/* Add pin mode toggle — accent fill when active, border when inactive */}
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

      {/* Change image — border style */}
      <button
        type="button"
        onClick={onChangeImage}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 text-sm px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
      >
        {COPY.changeImage}
      </button>
    </div>
  );
}
