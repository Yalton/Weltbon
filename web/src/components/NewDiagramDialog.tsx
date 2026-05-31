import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreateDiagram } from '../hooks/useDiagrams';

// ─── LOCKED copy strings (UI-SPEC §"New Diagram Dialog") ─────────────────────
const COPY = {
  dialogTitle: 'New diagram',
  fieldName: 'Name',
  placeholderName: 'e.g. Targaryen family tree',
  fieldDescription: 'Description (optional)',
  placeholderDescription: 'What this diagram shows',
  ctaCreate: 'Create diagram',
  ctaPending: 'Creating...',
  cancel: 'Discard',
  validationName: 'Enter a name for this diagram.',
  saveFailed: "Couldn't create diagram. Try again.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
}

type FieldError = 'name' | 'save' | null;

export function NewDiagramDialog({ open, onOpenChange, universeId }: Props) {
  const createDiagram = useCreateDiagram(universeId);

  const nameId = useId();
  const descriptionId = useId();

  const [nameInput, setNameInput] = useState('');
  const [descInput, setDescInput] = useState('');
  const [errorField, setErrorField] = useState<FieldError>(null);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);

  // Reset form state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setNameInput('');
      setDescInput('');
      setErrorField(null);
      setErrorCopy(null);
    }
  }, [open]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!nameInput.trim()) {
      setErrorField('name');
      setErrorCopy(COPY.validationName);
      return;
    }

    setErrorField(null);
    setErrorCopy(null);

    try {
      await createDiagram.mutateAsync({
        name: nameInput.trim(),
        description: descInput.trim() || undefined,
      });
      onOpenChange(false);
    } catch {
      setErrorField('save');
      setErrorCopy(COPY.saveFailed);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            {COPY.dialogTitle}
          </Dialog.Title>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            {/* Name (required) */}
            <div>
              <label htmlFor={nameId} className="block text-sm mb-1">
                {COPY.fieldName}
              </label>
              <input
                id={nameId}
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder={COPY.placeholderName}
                autoFocus
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              />
              {errorField === 'name' && errorCopy && (
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
              <input
                id={descriptionId}
                type="text"
                value={descInput}
                onChange={(e) => setDescInput(e.target.value)}
                placeholder={COPY.placeholderDescription}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              />
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
                disabled={createDiagram.isPending}
                className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50"
              >
                {createDiagram.isPending ? COPY.ctaPending : COPY.ctaCreate}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
