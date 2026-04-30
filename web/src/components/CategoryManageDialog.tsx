import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreateCategory, useUpdateCategory, type Category } from '../hooks/useCategories';

interface Props {
  universeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Non-null → edit mode. Null → create mode. */
  initialCategory: Category | null;
}

/**
 * Create / rename category dialog. Small Radix Dialog with label + icon text
 * inputs. Uses useCreateCategory / useUpdateCategory — closes on success.
 */
export function CategoryManageDialog({ universeId, open, onOpenChange, initialCategory }: Props) {
  const [label, setLabel] = useState('');
  const [icon, setIcon] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createCategory = useCreateCategory(universeId);
  const updateCategory = useUpdateCategory(universeId);

  const isEdit = initialCategory !== null;

  useEffect(() => {
    if (open) {
      setLabel(initialCategory?.label ?? '');
      setIcon(initialCategory?.icon ?? '');
      setError(null);
    }
  }, [open, initialCategory]);

  const canSubmit = label.trim().length > 0 && !createCategory.isPending && !updateCategory.isPending;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      if (isEdit && initialCategory) {
        await updateCategory.mutateAsync({
          id: initialCategory.id,
          patch: { label: label.trim(), icon: icon.trim() },
        });
      } else {
        await createCategory.mutateAsync({
          label: label.trim(),
          icon: icon.trim() || undefined,
        });
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            {isEdit ? 'Rename category' : 'New category'}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {isEdit ? 'Edit the label or icon for this category.' : 'Create a new category with a label and optional icon.'}
          </Dialog.Description>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <div>
              <label htmlFor="category-label" className="block text-sm mb-1">
                Label
              </label>
              <input
                id="category-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={80}
                autoFocus
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="category-icon" className="block text-sm mb-1">
                Icon (emoji, optional)
              </label>
              <input
                id="category-icon"
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                maxLength={10}
                placeholder="e.g. 🧝"
                className="w-24 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              />
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSubmit}
                className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createCategory.isPending || updateCategory.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
