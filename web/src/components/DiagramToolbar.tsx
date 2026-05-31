// Locked copy block (UI-SPEC "Diagram Editor" copy table — toolbar section).
const COPY = {
  stat: (nodeCount: number, edgeCount: number) =>
    `${nodeCount} nodes · ${edgeCount} edges`,
  addEntries: 'Add entries',
  editOff: 'Edit',
  editOn: 'Editing',
  editTitleOff: 'Drag between nodes to draw an edge',
  editTitleOn: 'Press Esc to exit edit mode',
  autoLayout: 'Auto-layout',
  exportJson: 'Export JSON',
  undoLabel: 'Undo',
  redoLabel: 'Redo',
  undoDisabledTitle: 'Nothing to undo',
  redoDisabledTitle: 'Nothing to redo',
  familyTreeMode: 'Family tree mode',
  familyTreeHint: 'Parent edges drive the top-down layout.',
} as const;

export interface DiagramToolbarProps {
  nodeCount: number;
  edgeCount: number;
  /** Whether the Add Entries picker is open (controls button appearance). */
  pickerOpen: boolean;
  onTogglePicker: () => void;
  /** Whether the canvas is in draw-edge edit mode. */
  editMode: boolean;
  onToggleEditMode: () => void;
  /** Whether family-tree mode is active (shows Auto-layout button when true). */
  familyTreeMode: boolean;
  onToggleFamilyTreeMode: () => void;
  onAutoLayout: () => void;
  /** Whether there are items on the undo stack. */
  canUndo: boolean;
  onUndo: () => void;
  /** Whether there are items on the redo stack. */
  canRedo: boolean;
  onRedo: () => void;
  onExportJson: () => void;
}

/**
 * Floating toolbar overlay for the DiagramEditor.
 *
 * Structure:
 *   - pointer-events-none absolute container (inset-x-0 top-3 z-10)
 *   - left: stat text "{N} nodes · {M} edges"
 *   - right: action cluster (Add entries, Family tree mode toggle, Edit/Editing,
 *            Auto-layout, Undo, Redo, Export JSON)
 *
 * Mirrors GraphView toolbar layout exactly (pointer-events-none outer container,
 * pointer-events-auto children).
 */
export function DiagramToolbar({
  nodeCount,
  edgeCount,
  pickerOpen,
  onTogglePicker,
  editMode,
  onToggleEditMode,
  familyTreeMode,
  onToggleFamilyTreeMode,
  onAutoLayout,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
  onExportJson,
}: DiagramToolbarProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex items-start justify-between gap-3 px-3">
      {/* Left: stat */}
      <div className="pointer-events-auto text-xs text-neutral-500 dark:text-neutral-400">
        {COPY.stat(nodeCount, edgeCount)}
      </div>

      {/* Right: action cluster */}
      <div className="pointer-events-auto flex items-center gap-2 flex-wrap justify-end">
        {/* Add entries */}
        <button
          type="button"
          onClick={onTogglePicker}
          aria-pressed={pickerOpen}
          className={[
            'rounded-md px-3 py-1.5 text-sm shadow-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900',
            pickerOpen
              ? 'border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
              : 'border border-neutral-300 bg-white/80 hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900',
          ].join(' ')}
        >
          {COPY.addEntries}
        </button>

        {/* Family tree mode toggle */}
        <label className="flex items-center gap-1.5 cursor-pointer pointer-events-auto">
          <input
            type="checkbox"
            checked={familyTreeMode}
            onChange={onToggleFamilyTreeMode}
            className="accent-[var(--color-accent)]"
          />
          <span className="text-xs text-neutral-700 dark:text-neutral-300">
            {COPY.familyTreeMode}
          </span>
          <span
            className="text-xs text-neutral-400 dark:text-neutral-500 hidden sm:inline"
            title={COPY.familyTreeHint}
          >
            {COPY.familyTreeHint}
          </span>
        </label>

        {/* Edit / Editing toggle */}
        <button
          type="button"
          onClick={onToggleEditMode}
          aria-pressed={editMode}
          aria-label={editMode ? 'Exit edit mode' : 'Enter edit mode'}
          title={editMode ? COPY.editTitleOn : COPY.editTitleOff}
          className={[
            'rounded-md px-3 py-1.5 text-sm shadow-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900',
            editMode
              ? 'border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
              : 'border border-neutral-300 bg-white/80 hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900',
          ].join(' ')}
        >
          {editMode ? COPY.editOn : COPY.editOff}
        </button>

        {/* Auto-layout — only shown when family-tree mode is on */}
        {familyTreeMode && (
          <button
            type="button"
            onClick={onAutoLayout}
            className="rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm shadow-sm hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
          >
            {COPY.autoLayout}
          </button>
        )}

        {/* Undo — aria-disabled (not disabled) so it stays keyboard-discoverable */}
        <button
          type="button"
          onClick={canUndo ? onUndo : undefined}
          aria-label={COPY.undoLabel}
          aria-disabled={!canUndo}
          title={canUndo ? undefined : COPY.undoDisabledTitle}
          className={[
            'rounded-md border px-3 py-1.5 text-sm shadow-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
            canUndo
              ? 'border-neutral-300 bg-white/80 hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900'
              : 'border-neutral-200 bg-white/50 text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-600 cursor-not-allowed',
          ].join(' ')}
        >
          {COPY.undoLabel}
        </button>

        {/* Redo — aria-disabled (not disabled) */}
        <button
          type="button"
          onClick={canRedo ? onRedo : undefined}
          aria-label={COPY.redoLabel}
          aria-disabled={!canRedo}
          title={canRedo ? undefined : COPY.redoDisabledTitle}
          className={[
            'rounded-md border px-3 py-1.5 text-sm shadow-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
            canRedo
              ? 'border-neutral-300 bg-white/80 hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900'
              : 'border-neutral-200 bg-white/50 text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-600 cursor-not-allowed',
          ].join(' ')}
        >
          {COPY.redoLabel}
        </button>

        {/* Export JSON */}
        <button
          type="button"
          onClick={onExportJson}
          className="rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm shadow-sm hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        >
          {COPY.exportJson}
        </button>
      </div>
    </div>
  );
}
