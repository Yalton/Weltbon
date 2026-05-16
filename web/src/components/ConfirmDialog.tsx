import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  confirmPhrase?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  confirmPhrase,
}: Props) {
  const inputId = useId();
  const labelId = useId();
  const [typed, setTyped] = useState('');

  const requireMatch = !!confirmPhrase;
  const matched = !requireMatch || typed.trim() === confirmPhrase;

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const handleConfirm = async () => {
    await onConfirm();
    onOpenChange(false);
  };

  const destructiveBaseClass =
    'px-3 py-1.5 text-sm rounded-md bg-red-600 text-white hover:bg-red-700';
  const destructiveDisabledClass =
    ' disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-red-600';
  const nonDestructiveClass =
    'px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white';

  const confirmDisabled = requireMatch && !matched;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          {body && <Dialog.Description className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">{body}</Dialog.Description>}
          {requireMatch && (
            <>
              <label
                id={labelId}
                htmlFor={inputId}
                className="block mt-4 text-sm text-neutral-700 dark:text-neutral-300"
              >
                Type <span className="font-mono">{confirmPhrase}</span> to confirm.
              </label>
              <input
                id={inputId}
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label="Type universe name to confirm deletion"
                aria-describedby={labelId}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typed.trim() === confirmPhrase) {
                    void handleConfirm();
                  }
                }}
                className="mt-2 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              />
            </>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700">
              {cancelLabel}
            </Dialog.Close>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirmDisabled}
              title={confirmDisabled ? 'Type the universe name above to enable Delete' : undefined}
              className={
                destructive
                  ? destructiveBaseClass + destructiveDisabledClass
                  : nonDestructiveClass
              }
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
