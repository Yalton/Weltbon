import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  dialogOverlayClasses,
  dialogContentClasses,
  dialogTitleClasses,
} from './ui/overlay';
import { Input } from './ui/Input';
import { Button } from './ui/Button';

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

  const confirmDisabled = requireMatch && !matched;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClasses} />
        <Dialog.Content className={`${dialogContentClasses} max-w-sm`}>
          <Dialog.Title className={dialogTitleClasses}>{title}</Dialog.Title>
          {body && <Dialog.Description className="mt-2 text-sm text-ink-secondary">{body}</Dialog.Description>}
          {requireMatch && (
            <>
              <label
                id={labelId}
                htmlFor={inputId}
                className="block mt-4 text-sm text-ink-secondary"
              >
                Type <span className="font-mono">{confirmPhrase}</span> to confirm.
              </label>
              <Input
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
                className="mt-2"
              />
            </>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost">{cancelLabel}</Button>
            </Dialog.Close>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              onClick={handleConfirm}
              disabled={confirmDisabled}
              title={confirmDisabled ? 'Type the universe name above to enable Delete' : undefined}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
