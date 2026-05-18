import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useUpsertTimelinePin } from '../hooks/useTimelinePins';
import { parsePosition } from '../lib/parsePosition';
import { PrecisionBadge, type Precision } from './PrecisionBadge';

const PRECISIONS: Precision[] = ['exact', 'approximate', 'era'];

/**
 * Locked copy from UI-SPEC §Copywriting Contract — keep verbatim. The
 * acceptance criteria for Plan 20-04 verifies these literal strings.
 */
const COPY = {
  TITLE: 'Pin entry',
  POSITION_LABEL: 'Position',
  POSITION_HINT: 'Adjust the exact position if needed.',
  POSITION_INVALID: 'Enter a valid number (e.g. 4.35e17 or -10000).',
  LABEL_LABEL: 'Label (optional)',
  PRECISION_LABEL: 'Precision',
  CANCEL: 'Discard pin',
  PRIMARY: 'Pin entry',
  ERROR_SAVE: "Couldn't save pin. Try again.",
} as const;

export interface PinPopoverProps {
  universeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryId: string;
  /** Container-relative drop coordinates (UI-SPEC §Interaction Contract). */
  dropX: number;
  dropY: number;
  /** Initial position translated from dropX via xToPos (D-07 linear). */
  initialPosition: number;
  /** Initial label hint (typically the entry title). */
  initialLabel?: string;
  /**
   * Error bridge — fires alongside the inline error message so the parent
   * (Plan 06 TimelineView) can surface a Toast. Popover stays open on error.
   */
  onError?: (err: unknown) => void;
}

/**
 * Radix Popover for confirming a fresh pin creation at a dropped position
 * (TIMELINE-05). Mirrors `CreateLinkPopover` lifecycle (Esc / outside-click
 * close, inline error + onError on mutation rejection — UI-SPEC §H
 * belt-and-suspenders).
 *
 * Saves via `useUpsertTimelinePin` (D-08: no new endpoint — the existing
 * upsert handles both create and reposition).
 */
export function PinPopover({
  universeId,
  open,
  onOpenChange,
  entryId,
  dropX,
  dropY,
  initialPosition,
  initialLabel,
  onError,
}: PinPopoverProps) {
  const [positionInput, setPositionInput] = useState<string>(String(initialPosition));
  const [label, setLabel] = useState<string>(initialLabel ?? '');
  const [precision, setPrecision] = useState<Precision>('exact');
  const [error, setError] = useState<string | null>(null);

  const upsert = useUpsertTimelinePin(universeId);
  const pending = upsert.isPending;

  const livePosition = useMemo(() => parsePosition(positionInput), [positionInput]);

  const handleSave = async () => {
    setError(null);
    const parsed = parsePosition(positionInput);
    if (!parsed.ok) {
      setError(COPY.POSITION_INVALID);
      return;
    }
    try {
      await upsert.mutateAsync({
        entryId,
        label: label.trim(),
        position: parsed.value,
        precision,
      });
      onOpenChange(false);
    } catch (err) {
      setError(COPY.ERROR_SAVE);
      onError?.(err);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
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
          onOpenAutoFocus={(e) => {
            // Let Radix focus the first input naturally; preventing the
            // default focus scope would skip the position input's autoFocus.
            // No-op kept for parity with CreateLinkPopover semantics.
            void e;
          }}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            onOpenChange(false);
          }}
          onPointerDownOutside={() => onOpenChange(false)}
          className="w-[320px] bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50 p-4 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          <h3 className="text-lg font-semibold mb-3">{COPY.TITLE}</h3>

          <div className="space-y-3">
            <div>
              <label htmlFor="pin-popover-position" className="block text-sm mb-1">
                {COPY.POSITION_LABEL}
              </label>
              <input
                id="pin-popover-position"
                type="text"
                value={positionInput}
                onChange={(e) => setPositionInput(e.target.value)}
                placeholder="e.g. -10000 or 4.35e17"
                autoFocus
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm font-mono"
              />
              <p className="mt-1 text-xs text-neutral-500">{COPY.POSITION_HINT}</p>
              {livePosition.ok && positionInput.trim() !== '' && (
                <p className="mt-1 text-xs text-neutral-500 tabular-nums">
                  → {livePosition.value}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="pin-popover-label" className="block text-sm mb-1">
                {COPY.LABEL_LABEL}
              </label>
              <input
                id="pin-popover-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={120}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="pin-popover-precision" className="block text-sm mb-1">
                {COPY.PRECISION_LABEL}
              </label>
              <div className="flex items-center gap-3">
                <select
                  id="pin-popover-precision"
                  value={precision}
                  onChange={(e) => setPrecision(e.target.value as Precision)}
                  className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
                >
                  {PRECISIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <PrecisionBadge precision={precision} />
              </div>
            </div>
          </div>

          {error && (
            <p className="mt-3 text-xs text-red-500" role="alert">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm"
            >
              {COPY.CANCEL}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={pending}
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {COPY.PRIMARY}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
