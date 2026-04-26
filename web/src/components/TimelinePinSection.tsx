import { useState } from 'react';
import {
  useTimelinePins,
  useDeleteTimelinePin,
} from '../hooks/useTimelinePins';
import { PinEditor } from './PinEditor';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  universeId: string;
  entryId: string;
}

/**
 * Tailwind classes for the small precision dot on the pin display.
 * Matches research §17 question 3:
 *   era         → accent (violet)
 *   approximate → neutral-400 (mid grey)
 *   exact       → neutral-200 (light grey)
 */
function precisionDotClass(p: 'exact' | 'approximate' | 'era'): string {
  const base = 'inline-block w-2 h-2 rounded-full';
  switch (p) {
    case 'era':
      return `${base} bg-[color:var(--color-accent)]`;
    case 'approximate':
      return `${base} bg-neutral-400`;
    case 'exact':
    default:
      return `${base} bg-neutral-200 dark:bg-neutral-300`;
  }
}

function PrecisionBadge({
  precision,
}: {
  precision: 'exact' | 'approximate' | 'era';
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={precisionDotClass(precision)} />
      <span className="text-xs text-neutral-500">{precision}</span>
    </span>
  );
}

/**
 * Per-entry timeline section rendered on EntryDetail below IssueSection.
 *
 * Reads useTimelinePins (cached query — no second API call when /timeline is
 * already loaded), finds the pin where pin.entryId === entryId. Two states:
 *   - No pin: 'Not pinned' + 'Add pin' button → PinEditor (currentPin=null)
 *   - Pin:    label + position + PrecisionBadge + Edit + Remove buttons
 *
 * Edit reopens PinEditor with currentPin pre-filled. Remove opens a
 * ConfirmDialog and calls useDeleteTimelinePin on confirm.
 */
export function TimelinePinSection({ universeId, entryId }: Props) {
  const { data: pins, isLoading } = useTimelinePins(universeId);
  const remove = useDeleteTimelinePin(universeId);

  const [editorOpen, setEditorOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const currentPin = pins?.find((p) => p.entryId === entryId) ?? null;

  const handleConfirmRemove = async () => {
    await remove.mutateAsync(entryId);
  };

  return (
    <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Timeline</h2>
      </div>

      {isLoading ? (
        <p className="mt-3 text-sm text-neutral-500">Loading…</p>
      ) : currentPin ? (
        <div className="mt-3 flex items-center justify-between rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2">
          <span className="flex items-center gap-3">
            <PrecisionBadge precision={currentPin.precision} />
            <span className="text-sm font-medium">{currentPin.label}</span>
            <span className="text-sm text-neutral-500 tabular-nums">
              {currentPin.position}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="text-xs text-neutral-400 hover:text-neutral-200"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="text-xs text-red-500 hover:text-red-400"
            >
              Remove
            </button>
          </span>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-sm text-neutral-500">Not pinned</p>
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
          >
            Add pin
          </button>
        </div>
      )}

      <PinEditor
        universeId={universeId}
        entryId={entryId}
        currentPin={currentPin}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove pin?"
        body="This removes the timeline pin for this entry. The entry itself is unaffected."
        confirmLabel="Remove"
        destructive
        onConfirm={handleConfirmRemove}
      />
    </div>
  );
}
