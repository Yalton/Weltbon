import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  useUpsertTimelinePin,
  type TimelinePin,
} from '../hooks/useTimelinePins';
import { parsePosition } from '../lib/parsePosition';

interface Props {
  universeId: string;
  entryId: string;
  currentPin: TimelinePin | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PRECISIONS: Array<'exact' | 'approximate' | 'era'> = [
  'exact',
  'approximate',
  'era',
];

export function PinEditor({
  universeId,
  entryId,
  currentPin,
  open,
  onOpenChange,
}: Props) {
  const [label, setLabel] = useState('');
  const [positionInput, setPositionInput] = useState('');
  const [precision, setPrecision] =
    useState<'exact' | 'approximate' | 'era'>('exact');
  const [error, setError] = useState<string | null>(null);

  const upsert = useUpsertTimelinePin(universeId);

  const isEdit = currentPin !== null;

  useEffect(() => {
    if (open) {
      setLabel(currentPin?.label ?? '');
      setPositionInput(
        currentPin?.position !== undefined ? String(currentPin.position) : '',
      );
      setPrecision(currentPin?.precision ?? 'exact');
      setError(null);
    }
  }, [open, currentPin]);

  // submit re-validates so the error message lands at the right moment).
  const livePosition = parsePosition(positionInput);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) {
      setError('Label is required');
      return;
    }
    const parsed = parsePosition(positionInput);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    try {
      await upsert.mutateAsync({
        entryId,
        label: label.trim(),
        position: parsed.value,
        precision,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save pin');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-panel border border-line rounded-md p-6 shadow-lg z-50 data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            {isEdit ? 'Edit pin' : 'Pin to timeline'}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {isEdit
              ? 'Edit the timeline pin label, position, or precision.'
              : 'Pin this entry to the timeline with a label, position, and precision.'}
          </Dialog.Description>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <div>
              <label htmlFor="pin-position" className="block text-sm mb-1">
                Position
              </label>
              <input
                id="pin-position"
                type="text"
                value={positionInput}
                onChange={(e) => setPositionInput(e.target.value)}
                placeholder="e.g. -10000 or 4.35e17"
                autoFocus
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm font-mono"
              />
              {livePosition.ok && positionInput.trim() !== '' && (
                <p className="mt-1 text-xs text-ink-muted tabular-nums">
                  → {livePosition.value}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="pin-label" className="block text-sm mb-1">
                Label
              </label>
              <input
                id="pin-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={120}
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="pin-precision" className="block text-sm mb-1">
                Precision
              </label>
              <select
                id="pin-precision"
                value={precision}
                onChange={(e) =>
                  setPrecision(e.target.value as 'exact' | 'approximate' | 'era')
                }
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              >
                {PRECISIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-line-strong">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={upsert.isPending}
                className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50"
              >
                {upsert.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
