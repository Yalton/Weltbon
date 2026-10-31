import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { entryTypeHexColor } from '../lib/entryTypeColor';

// 6-swatch edge color palette derived from entryTypeColor.ts real constants.
// Default is the neutral fallback gray; remaining 5 are stable entry-type hexes.
export const EDGE_PALETTE: readonly string[] = [
  '#6b7280', // gray — ENTRY_TYPE_HEX_FALLBACK (neutral default)
  entryTypeHexColor('concept'), // #3b82f6 blue
  entryTypeHexColor('entity'), // #10b981 emerald
  entryTypeHexColor('location'), // #f59e0b amber
  entryTypeHexColor('event'), // #f43f5e rose
  entryTypeHexColor('faction'), // #a855f7 purple
] as const;

export type LineStyle = 'solid' | 'dashed' | 'dotted';

// Locked copy block (UI-SPEC "Draw-Edge Popover" copy table).
const COPY = {
  title: 'Draw edge',
  titleEdit: 'Edit edge',
  fromCaption: 'From',
  toCaption: 'To',
  labelPlaceholder: 'Relation label (optional)',
  styleLabel: 'Style',
  styleOptions: [
    { value: 'solid' as LineStyle, label: 'Solid' },
    { value: 'dashed' as LineStyle, label: 'Dashed' },
    { value: 'dotted' as LineStyle, label: 'Dotted' },
  ],
  colorLabel: 'Color',
  submit: 'Draw edge',
  submitEdit: 'Save changes',
  pending: 'Drawing...',
  pendingEdit: 'Saving...',
  cancel: 'Discard',
  error: "Couldn't draw edge. Try again.",
} as const;

export interface InitialEdgeValues {
  label: string;
  lineStyle: LineStyle;
  color: string;
}

export interface DrawEdgePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromTitle: string;
  toTitle: string;
  dropX: number;
  dropY: number;
  onSubmit: (opts: { label: string; lineStyle: LineStyle; color: string }) => Promise<void>;
  onError?: (err: unknown) => void;
  initialEdge?: InitialEdgeValues;
  mode?: 'create' | 'edit';
}

export function DrawEdgePopover({
  open,
  onOpenChange,
  fromTitle,
  toTitle,
  dropX,
  dropY,
  onSubmit,
  onError,
  initialEdge,
  mode = 'create',
}: DrawEdgePopoverProps) {
  const isEdit = mode === 'edit';
  const [label, setLabel] = useState(initialEdge?.label ?? '');
  const [lineStyle, setLineStyle] = useState<LineStyle>(initialEdge?.lineStyle ?? 'solid');
  const [color, setColor] = useState<string>(initialEdge?.color ?? EDGE_PALETTE[0]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const handleSubmit = async () => {
    try {
      setError(null);
      setPending(true);
      await onSubmit({ label: label.trim(), lineStyle, color });
      onOpenChange(false);
    } catch (err) {
      setError(err);
      onError?.(err);
    } finally {
      setPending(false);
    }
  };

  // In edit mode, reset to the initialEdge values (not blank) so re-opens reflect
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setLabel(isEdit && initialEdge ? initialEdge.label : '');
      setLineStyle(isEdit && initialEdge ? initialEdge.lineStyle : 'solid');
      setColor(isEdit && initialEdge ? initialEdge.color : EDGE_PALETTE[0]);
      setError(null);
      setPending(false);
    }
    onOpenChange(next);
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Anchor asChild>
        <div
          style={{
            position: 'absolute',
            left: dropX,
            top: dropY,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={12}
          collisionPadding={8}
          // Prevent FocusScope from auto-focusing the label input on open,
          // mirroring CreateLinkPopover.tsx behavior (UI-SPEC §E).
          onOpenAutoFocus={(e) => e.preventDefault()}
          // Priority 1: close popover on Esc (UI-SPEC Esc order).
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            handleOpenChange(false);
          }}
          onPointerDownOutside={() => handleOpenChange(false)}
          className="w-[300px] bg-panel border border-line rounded-md shadow-lg z-50 p-4 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          <h3 className="text-sm font-semibold mb-3">{isEdit ? COPY.titleEdit : COPY.title}</h3>

          {/* From / To rows */}
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-ink-secondary w-10 shrink-0">
              {COPY.fromCaption}
            </span>
            <span
              className="text-sm font-medium text-ink truncate"
              title={fromTitle}
            >
              {fromTitle}
            </span>
          </div>
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-xs text-ink-secondary w-10 shrink-0">
              {COPY.toCaption}
            </span>
            <span
              className="text-sm font-medium text-ink truncate"
              title={toTitle}
            >
              {toTitle}
            </span>
          </div>

          {/* Relation label input */}
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={COPY.labelPlaceholder}
            className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
          />

          {/* Line style radio group */}
          <div className="mt-3">
            <p className="text-xs text-ink-secondary mb-1.5">
              {COPY.styleLabel}
            </p>
            <div className="flex gap-2">
              {COPY.styleOptions.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="lineStyle"
                    value={opt.value}
                    checked={lineStyle === opt.value}
                    onChange={() => setLineStyle(opt.value)}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-xs text-ink">
                    {opt.label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Color picker — 6 circular 20x20 swatches */}
          <div className="mt-3">
            <p className="text-xs text-ink-secondary mb-1.5">
              {COPY.colorLabel}
            </p>
            <div className="flex gap-2">
              {EDGE_PALETTE.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  aria-label={`Color ${hex}`}
                  onClick={() => setColor(hex)}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    backgroundColor: hex,
                    border: 'none',
                    outline: color === hex ? '2px solid var(--color-accent)' : '2px solid transparent',
                    outlineOffset: 1,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                />
              ))}
            </div>
          </div>

          {error != null && (
            <p className="mt-2 text-xs text-red-500">{COPY.error}</p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm"
            >
              {COPY.cancel}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={pending}
              className="rounded-md btn-accent text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pending
                ? (isEdit ? COPY.pendingEdit : COPY.pending)
                : (isEdit ? COPY.submitEdit : COPY.submit)}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
