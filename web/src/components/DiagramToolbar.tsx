import * as Select from '@radix-ui/react-select';


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
  exportSvg: 'Export SVG',
  exportPng: 'Export PNG',
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
  snapToGrid: 'Snap to grid',
  alignLeft: 'Align left',
  alignRight: 'Align right',
  alignTop: 'Align top',
  alignBottom: 'Align bottom',
  centerH: 'Center H',
  centerV: 'Center V',
  distributeH: 'Distribute H',
  distributeV: 'Distribute V',
  alignDisabledTitle: 'Select 2+ nodes to align',
  distributeDisabledTitle: 'Select 3+ nodes to distribute',
} as const;

export interface DiagramToolbarProps {
  nodeCount: number;
  edgeCount: number;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  editMode: boolean;
  onToggleEditMode: () => void;
  layoutMode: LayoutMode;
  onSetLayoutMode: (mode: LayoutMode) => void;
  onAutoLayout: () => void;
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;
  onExportJson: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  selectionCount: number;
  onAlignLeft: () => void;
  onAlignRight: () => void;
  onAlignTop: () => void;
  onAlignBottom: () => void;
  onCenterH: () => void;
  onCenterV: () => void;
  onDistributeH: () => void;
  onDistributeV: () => void;
}

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
  onExportSvg,
  onExportPng,
  snapEnabled,
  onToggleSnap,
  selectionCount,
  onAlignLeft,
  onAlignRight,
  onAlignTop,
  onAlignBottom,
  onCenterH,
  onCenterV,
  onDistributeH,
  onDistributeV,
}: DiagramToolbarProps) {
  const layoutHint =
    layoutMode === 'org-chart'
      ? COPY.orgChartHint
      : layoutMode === 'family-tree'
        ? COPY.familyTreeHint
        : null;

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
      <div className="pointer-events-auto text-xs text-ink-secondary">
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
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-canvas-mid)]',
            pickerOpen
              ? 'border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
              : 'border border-line-strong bg-panel text-ink hover:bg-white/[0.03]',
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
                  : ' border-line-strong bg-panel text-ink hover:bg-white/[0.03]',
              ].join(' ')}
            >
              <Select.Value />
              <Select.Icon className="ml-1 text-xs opacity-60">▾</Select.Icon>
            </Select.Trigger>

            <Select.Portal>
              <Select.Content
                className="z-50 min-w-[160px] overflow-hidden rounded-md border shadow-md border-line-strong bg-panel"
                position="popper"
                sideOffset={4}
              >
                <Select.Viewport className="p-1">
                  <Select.Item
                    value="none"
                    className="flex cursor-pointer items-center rounded px-3 py-1.5 text-sm outline-none text-ink hover:bg-white/5 data-[highlighted]:bg-white/5"
                  >
                    <Select.ItemText>{COPY.layoutModeNone}</Select.ItemText>
                  </Select.Item>
                  <Select.Item
                    value="family-tree"
                    className="flex cursor-pointer items-center rounded px-3 py-1.5 text-sm outline-none text-ink hover:bg-white/5 data-[highlighted]:bg-white/5"
                  >
                    <Select.ItemText>{COPY.familyTreeMode}</Select.ItemText>
                  </Select.Item>
                  <Select.Item
                    value="org-chart"
                    className="flex cursor-pointer items-center rounded px-3 py-1.5 text-sm outline-none text-ink hover:bg-white/5 data-[highlighted]:bg-white/5"
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
              className="text-xs text-ink-muted hidden sm:inline"
              title={layoutHint}
            >
              {layoutHint}
            </span>
          )}
        </div>

        {/* Snap to grid toggle — mirrors layout-mode toggle styling */}
        <button
          type="button"
          onClick={onToggleSnap}
          aria-pressed={snapEnabled}
          aria-label="Snap to grid"
          className={[
            'rounded-md px-3 py-1.5 text-sm shadow-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
            snapEnabled
              ? 'border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
              : 'border border-line-strong bg-panel text-ink hover:bg-white/[0.03]',
          ].join(' ')}
        >
          {COPY.snapToGrid}
        </button>

        {/* Align / distribute controls — text-label buttons, no icon import.
            Align: enabled when selectionCount >= 2; aria-disabled otherwise.
            Distribute: enabled when selectionCount >= 3; aria-disabled otherwise. */}
        {selectionCount >= 2 && (
          <div className="flex items-center gap-1">
            {(
              [
                { label: COPY.alignLeft, handler: onAlignLeft, 'aria-label': 'Align left' },
                { label: COPY.alignRight, handler: onAlignRight, 'aria-label': 'Align right' },
                { label: COPY.alignTop, handler: onAlignTop, 'aria-label': 'Align top' },
                { label: COPY.alignBottom, handler: onAlignBottom, 'aria-label': 'Align bottom' },
                { label: COPY.centerH, handler: onCenterH, 'aria-label': 'Center H' },
                { label: COPY.centerV, handler: onCenterV, 'aria-label': 'Center V' },
              ] as const
            ).map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.handler}
                aria-label={item['aria-label']}
                className="rounded-md border px-2 py-1.5 text-xs shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
              >
                {item.label}
              </button>
            ))}
            {selectionCount >= 3 && (
              <>
                <button
                  type="button"
                  onClick={onDistributeH}
                  aria-label="Distribute H"
                  className="rounded-md border px-2 py-1.5 text-xs shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                >
                  {COPY.distributeH}
                </button>
                <button
                  type="button"
                  onClick={onDistributeV}
                  aria-label="Distribute V"
                  className="rounded-md border px-2 py-1.5 text-xs shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                >
                  {COPY.distributeV}
                </button>
              </>
            )}
          </div>
        )}
        {/* When fewer than 2 selected: show aria-disabled align placeholder */}
        {selectionCount < 2 && (
          <button
            type="button"
            aria-disabled="true"
            aria-label="Align (select 2+ nodes)"
            title={COPY.alignDisabledTitle}
            className="rounded-md border px-2 py-1.5 text-xs border-line bg-panel text-ink-muted cursor-not-allowed"
          >
            Align
          </button>
        )}

        {/* Edit / Editing toggle */}
        <button
          type="button"
          onClick={onToggleEditMode}
          aria-pressed={editMode}
          aria-label={editMode ? 'Exit edit mode' : 'Enter edit mode'}
          title={editMode ? COPY.editTitleOn : COPY.editTitleOff}
          className={[
            'rounded-md px-3 py-1.5 text-sm shadow-sm transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-canvas-mid)]',
            editMode
              ? 'border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
              : 'border border-line-strong bg-panel text-ink hover:bg-white/[0.03]',
          ].join(' ')}
        >
          {editMode ? COPY.editOn : COPY.editOff}
        </button>

        {/* Auto-layout — only shown when a layout mode is active */}
        {layoutMode !== null && (
          <button
            type="button"
            onClick={onAutoLayout}
            className="rounded-md border px-3 py-1.5 text-sm shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
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
              ? ' border-line-strong bg-panel text-ink hover:bg-white/[0.03]'
              : ' border-line bg-panel text-ink-muted cursor-not-allowed',
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
              ? ' border-line-strong bg-panel text-ink hover:bg-white/[0.03]'
              : ' border-line bg-panel text-ink-muted cursor-not-allowed',
          ].join(' ')}
        >
          {COPY.redoLabel}
        </button>

        {/* Export JSON */}
        <button
          type="button"
          onClick={onExportJson}
          className="rounded-md border px-3 py-1.5 text-sm shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        >
          {COPY.exportJson}
        </button>

        {/* Export SVG */}
        <button
          type="button"
          onClick={onExportSvg}
          className="rounded-md border px-3 py-1.5 text-sm shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        >
          {COPY.exportSvg}
        </button>

        {/* Export PNG */}
        <button
          type="button"
          onClick={onExportPng}
          className="rounded-md border px-3 py-1.5 text-sm shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        >
          {COPY.exportPng}
        </button>
      </div>
    </div>
  );
}
