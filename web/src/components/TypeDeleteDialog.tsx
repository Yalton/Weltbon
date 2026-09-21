import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  typeName: string;
  count: number;
  candidates: string[];
  onConfirm: (fallback: string) => Promise<void>;
}

export function TypeDeleteDialog({
  open,
  onOpenChange,
  typeName,
  count,
  candidates,
  onConfirm,
}: Props) {
  const [fallback, setFallback] = useState(candidates[0] ?? '');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) {
      setFallback(candidates[0] ?? '');
      setPending(false);
    }
  }, [open, candidates]);

  const handleConfirm = async () => {
    if (!fallback) return;
    setPending(true);
    try {
      await onConfirm(fallback);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white dark:bg-neutral-900 rounded-md p-6 z-50 border border-neutral-200 dark:border-neutral-800">
          <Dialog.Title className="text-lg font-semibold">
            Delete &ldquo;{typeName}&rdquo;?
          </Dialog.Title>
          <Dialog.Description className="text-sm text-neutral-500 mt-2">
            {count} {count === 1 ? 'entry uses' : 'entries use'} this type. Pick a
            fallback type to reassign them to.
          </Dialog.Description>
          <label htmlFor="fallback-select" className="sr-only">
            Fallback type
          </label>
          <select
            id="fallback-select"
            value={fallback}
            onChange={(e) => setFallback(e.target.value)}
            className="mt-4 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          >
            {candidates.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2 mt-6">
            <Dialog.Close asChild>
              <button
                type="button"
                className="text-sm px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!fallback || pending}
              className="rounded-md bg-red-600 text-white text-sm px-3 py-1.5 disabled:opacity-50"
            >
              {pending ? 'Deleting…' : `Delete and reassign to "${fallback}"`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
