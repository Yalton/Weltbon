import * as Select from '@radix-ui/react-select';

// ─── Layout mode ──────────────────────────────────────────────────────────────

/**
 * Supported auto-layout modes.
 * - 'family-tree': BFS top-down layout driven by PARENT_TERMS edges (Plan 02).
 * - 'org-chart':   BFS top-down single-parent layout driven by MANAGER_TERMS edges (Plan 07).
 * - null: no layout mode selected; Auto-layout button is hidden.
 */
export type LayoutMode = 'family-tree' | 'org-chart' | null;

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
  orgChartMode: 'Org chart',
  orgChartHint: 'Reporting-line edges drive the top-down layout.',
  layoutModeLabel: 'Layout mode',
  layoutModeNone: 'None',
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
  /** Currently active auto-layout mode. null = no layout mode active. */
  layoutMode: LayoutMode;
  onSetLayoutMode: (mode: LayoutMode) => void;
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
 *   - right: action cluster (Add entries, Layout mode selector, Edit/Editing,
 *            Auto-layout (when a mode is active), Undo, Redo, Export JSON)
 *
 * Mirrors GraphView toolbar layout exactly (pointer-events-none outer container,
 * pointer-events-auto children).
 *
 * Layout mode selector: Radix Select offering "None", "Family tree mode", "Org chart".
 * Replaces Plan 06's family-tree checkbox toggle with a generalised mode picker.
 * The Auto-layout button is shown whenever layoutMode is non-null; the hint text
 * adapts to the selected mode.
 */
export function DiagramToolbar({
  nodeCount,
  edgeCount,
  pickerOpen,
  onTogglePicker,
  editMode,
  onToggleEditMode,
  layoutMode,
  onSetLayoutMode,
  onAutoLayout,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
  onExportJson,
}: DiagramToolbarProps) {
  // Determine hint text for the active layout mode
  const layoutHint =
    layoutMode === 'org-chart'
      ? COPY.orgChartHint
      : layoutMode === 'family-tree'
        ? COPY.familyTreeHint
        : null;

  // Map LayoutMode to select value string
  const selectValue: string = layoutMode ?? 'none';

  const handleSelectChange = (value: string) => {
    if (value === 'family-tree' || value === 'org-chart') {
      onSetLayoutMode(value as LayoutMode);
    } else {
      onSetLayoutMode(null);
    }
  };

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

        {/* Layout mode selector — Radix Select offering None / Family tree / Org chart */}
        <div className="flex items-center gap-1.5">
          <Select.Root value={selectValue} onValueChange={handleSelectChange}>
            <Select.Trigger
              aria-label={COPY.layoutModeLabel}
              className={[
                'flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm shadow-sm',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
                layoutMode !== null
                  ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
                  : 'border-neutral-300 bg-white/80 hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900',
              ].join(' ')}
            >
              <Select.Value />
              <Select.Icon className="ml-1 text-xs opacity-60">▾</Select.Icon>
            </Select.Trigger>

            <Select.Portal>
              <Select.Content
                className="z-50 min-w-[160px] overflow-hidden rounded-md border border-neutral-200 bg-white shadow-md dark:border-neutral-700 dark:bg-neutral-900"
                position="popper"
                sideOffset={4}
              >
                <Select.Viewport className="p-1">
                  <Select.Item
                    value="none"
                    className="flex cursor-pointer items-center rounded px-3 py-1.5 text-sm text-neutral-700 outline-none hover:bg-neutral-100 data-[highlighted]:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:data-[highlighted]:bg-neutral-800"
                  >
                    <Select.ItemText>{COPY.layoutModeNone}</Select.ItemText>
                  </Select.Item>
                  <Select.Item
                    value="family-tree"
                    className="flex cursor-pointer items-center rounded px-3 py-1.5 text-sm text-neutral-700 outline-none hover:bg-neutral-100 data-[highlighted]:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:data-[highlighted]:bg-neutral-800"
                  >
                    <Select.ItemText>{COPY.familyTreeMode}</Select.ItemText>
                  </Select.Item>
                  <Select.Item
                    value="org-chart"
                    className="flex cursor-pointer items-center rounded px-3 py-1.5 text-sm text-neutral-700 outline-none hover:bg-neutral-100 data-[highlighted]:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:data-[highlighted]:bg-neutral-800"
                  >
                    <Select.ItemText>{COPY.orgChartMode}</Select.ItemText>
                  </Select.Item>
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>

          {/* Hint text for the selected layout mode */}
          {layoutHint && (
            <span
              className="text-xs text-neutral-400 dark:text-neutral-500 hidden sm:inline"
              title={layoutHint}
            >
              {layoutHint}
            </span>
          )}
        </div>

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

        {/* Auto-layout — only shown when a layout mode is active */}
        {layoutMode !== null && (
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
