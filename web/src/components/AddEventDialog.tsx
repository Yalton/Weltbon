import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAddEvent } from '../hooks/useEvents';
import { useCalendar } from '../hooks/useCalendar';
import { formatCalendar } from '../lib/calendarFormat';
import { parsePosition } from '../lib/parsePosition';

// ─── LOCKED copy strings (UI-SPEC §"Add event / promote pin") ───────────────
const COPY = {
  titleCreate: 'Add event',
  titlePromote: 'Name this pin',
  description:
    "Events appear on your timeline and in the events list. The date is set by the position.",
  fieldTitle: 'Title',
  fieldDescription: 'Description (optional)',
  fieldPosition: 'Position',
  positionHintBase: "This sets the event's date.",
  ctaCreate: 'Add event',
  ctaPromote: 'Save event',
  cancel: 'Discard event',
  validationTitle: 'Enter a title for this event.',
  validationPosition: 'Enter a valid number (e.g. 412 or -10000).',
  saveFailed: "Couldn't save event. Try again.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
  /**
   * 'create' — blank dialog for adding a brand-new event (default).
   * 'promote' — dialog prefilled with an existing pin's position so the user
   *             can "name" it and convert it to a first-class event entry.
   */
  mode?: 'create' | 'promote';
  /** Initial position value (used in 'promote' mode to prefill the field). */
  initialPosition?: number;
}

type FieldError = 'title' | 'position' | 'save' | null;

export function AddEventDialog({
  open,
  onOpenChange,
  universeId,
  mode = 'create',
  initialPosition,
}: Props) {
  const addEvent = useAddEvent(universeId);
  const { calendar } = useCalendar(universeId);

  const titleId = useId();
  const descriptionId = useId();
  const positionId = useId();

  const [titleInput, setTitleInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [positionInput, setPositionInput] = useState('');
  const [errorField, setErrorField] = useState<FieldError>(null);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);

  // Reset / prefill form state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setTitleInput('');
      setDescInput('');
      setPositionInput(initialPosition !== undefined ? String(initialPosition) : '');
      setErrorField(null);
      setErrorCopy(null);
    }
  }, [open, initialPosition]);

  // Live position parse for hint.
  const livePosition = parsePosition(positionInput);

  // Compute position hint: "This sets the event's date. {formattedDate | raw}"
  const positionHint = (() => {
    if (!livePosition.ok || positionInput.trim() === '') return COPY.positionHintBase;
    const formatted = formatCalendar(livePosition.value, calendar);
    const datePart = formatted ? formatted.compact : String(livePosition.value);
    return `${COPY.positionHintBase} ${datePart}`;
  })();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!titleInput.trim()) {
      setErrorField('title');
      setErrorCopy(COPY.validationTitle);
      return;
    }

    const parsedPosition = parsePosition(positionInput);
    if (!parsedPosition.ok) {
      setErrorField('position');
      setErrorCopy(COPY.validationPosition);
      return;
    }

    setErrorField(null);
    setErrorCopy(null);

    try {
      await addEvent.mutateAsync({
        title: titleInput.trim(),
        description: descInput.trim() || undefined,
        position: parsedPosition.value,
      });
      onOpenChange(false);
    } catch {
      setErrorField('save');
      setErrorCopy(COPY.saveFailed);
    }
  };

  const dialogTitle = mode === 'promote' ? COPY.titlePromote : COPY.titleCreate;
  const ctaLabel = mode === 'promote' ? COPY.ctaPromote : COPY.ctaCreate;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            {dialogTitle}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            {COPY.description}
          </Dialog.Description>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            {/* Title (required) */}
            <div>
              <label htmlFor={titleId} className="block text-sm mb-1">
                {COPY.fieldTitle}
              </label>
              <input
                id={titleId}
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                placeholder="e.g. The Sundering"
                autoFocus
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              />
              {errorField === 'title' && errorCopy && (
                <p className="mt-1 text-xs text-red-500" role="alert">
                  {errorCopy}
                </p>
              )}
            </div>

            {/* Description (optional) */}
            <div>
              <label htmlFor={descriptionId} className="block text-sm mb-1">
                {COPY.fieldDescription}
              </label>
              <textarea
                id={descriptionId}
                value={descInput}
                onChange={(e) => setDescInput(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] resize-none"
              />
            </div>

            {/* Position (numeric) */}
            <div>
              <label htmlFor={positionId} className="block text-sm mb-1">
                {COPY.fieldPosition}
              </label>
              <input
                id={positionId}
                type="text"
                value={positionInput}
                onChange={(e) => setPositionInput(e.target.value)}
                placeholder="e.g. 412 or -10000"
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              />
              <p className="mt-1 text-xs text-neutral-500">
                {positionHint}
              </p>
              {errorField === 'position' && errorCopy && (
                <p className="mt-1 text-xs text-red-500" role="alert">
                  {errorCopy}
                </p>
              )}
            </div>

            {/* Save-level error */}
            {errorField === 'save' && errorCopy && (
              <p className="text-xs text-red-500" role="alert">
                {errorCopy}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700">
                {COPY.cancel}
              </Dialog.Close>
              <button
                type="submit"
                disabled={addEvent.isPending}
                className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50"
              >
                {addEvent.isPending ? 'Saving…' : ctaLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
