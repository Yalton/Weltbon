import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTimelineWindow } from '../hooks/useTimelineWindow';
import { parsePosition } from '../lib/parsePosition';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
}

type FieldError = 'start' | 'end' | 'order' | 'save' | null;

const DEFAULT_START = 0;
const DEFAULT_END = 1000;

const INVALID_NUMBER_COPY = 'Enter a valid number (e.g. -10000 or 4.35e17).';
const ORDER_COPY = 'Start must be less than end.';
const SAVE_FAILED_COPY = "Couldn't save range. Try again.";

export function TimelineRangeDialog({ open, onOpenChange, universeId }: Props) {
  const { window: persistedWindow, setWindow, isPending } =
    useTimelineWindow(universeId);

  const startId = useId();
  const endId = useId();

  const [startInput, setStartInput] = useState('');
  const [endInput, setEndInput] = useState('');
  const [errorField, setErrorField] = useState<FieldError>(null);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStartInput(persistedWindow ? String(persistedWindow.start) : String(DEFAULT_START));
      setEndInput(persistedWindow ? String(persistedWindow.end) : String(DEFAULT_END));
      setErrorField(null);
      setErrorCopy(null);
    }
  }, [open, persistedWindow]);

  // Live previews mirror PinEditor's tabular-nums hint.
  const liveStart = parsePosition(startInput);
  const liveEnd = parsePosition(endInput);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedStart = parsePosition(startInput);
    const parsedEnd = parsePosition(endInput);

    if (!parsedStart.ok) {
      setErrorField('start');
      setErrorCopy(INVALID_NUMBER_COPY);
      return;
    }
    if (!parsedEnd.ok) {
      setErrorField('end');
      setErrorCopy(INVALID_NUMBER_COPY);
      return;
    }
    if (parsedStart.value >= parsedEnd.value) {
      setErrorField('order');
      setErrorCopy(ORDER_COPY);
      return;
    }

    setErrorField(null);
    setErrorCopy(null);
    try {
      await setWindow({ start: parsedStart.value, end: parsedEnd.value });
      onOpenChange(false);
    } catch {
      setErrorField('save');
      setErrorCopy(SAVE_FAILED_COPY);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-panel border border-line rounded-md p-6 shadow-lg z-50 data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Close
            type="button"
            aria-label="Close timeline settings"
            title="Close without saving"
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] text-ink hover:bg-white/5 hover:text-white"
          >
            <span aria-hidden="true">×</span>
          </Dialog.Close>
          <Dialog.Title className="text-lg font-semibold">
            Configure timeline range
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-secondary">
            Set the start and end positions for this universe&rsquo;s timeline.
            Plain numbers work (e.g. -10000), and scientific notation is accepted
            for very large values (e.g. 4.35e17).
          </Dialog.Description>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <div>
              <label htmlFor={startId} className="block text-sm mb-1">
                Start position
              </label>
              <input
                id={startId}
                type="text"
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                placeholder="e.g. -10000"
                autoFocus
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              />
              {liveStart.ok && startInput.trim() !== '' && (
                <p className="mt-1 text-xs text-ink-muted tabular-nums">
                  → {liveStart.value}
                </p>
              )}
              {(errorField === 'start' || errorField === 'order') && errorCopy && (
                <p className="mt-1 text-xs text-red-500" role="alert">
                  {errorCopy}
                </p>
              )}
            </div>

            <div>
              <label htmlFor={endId} className="block text-sm mb-1">
                End position
              </label>
              <input
                id={endId}
                type="text"
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                placeholder="e.g. 3000"
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              />
              {liveEnd.ok && endInput.trim() !== '' && (
                <p className="mt-1 text-xs text-ink-muted tabular-nums">
                  → {liveEnd.value}
                </p>
              )}
              {errorField === 'end' && errorCopy && (
                <p className="mt-1 text-xs text-red-500" role="alert">
                  {errorCopy}
                </p>
              )}
            </div>

            {errorField === 'save' && errorCopy && (
              <p className="text-xs text-red-500" role="alert">
                {errorCopy}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-line-strong">
                {persistedWindow ? 'Keep current range' : 'Cancel'}
              </Dialog.Close>
              <button
                type="submit"
                disabled={isPending}
                className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50"
              >
                {isPending ? 'Saving…' : 'Save range'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
