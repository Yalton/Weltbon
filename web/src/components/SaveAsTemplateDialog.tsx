import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useCreateTemplate } from '../hooks/useTemplates';
import { ApiError, UnauthenticatedError } from '../api/client';

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(80, 'Name can be at most 80 characters.'),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entryType: string;
  captureSnapshot: () => {
    summary: string;
    body: string;
    meta: Array<{ name: string; default_value: string }>;
  };
  onSuccess?: () => void;
  onGenericError?: () => void;
}

export function SaveAsTemplateDialog({
  open,
  onOpenChange,
  entryType,
  captureSnapshot,
  onSuccess,
  onGenericError,
}: Props) {
  const createTemplate = useCreateTemplate();
  const [collisionError, setCollisionError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      reset({ name: '' });
      setCollisionError(null);
    }
    onOpenChange(nextOpen);
  };

  const onSubmit = async (values: FormValues) => {
    setCollisionError(null);
    const snap = captureSnapshot();
    try {
      await createTemplate.mutateAsync({
        name: values.name,
        entryType,
        summary: snap.summary,
        body: snap.body,
        meta: snap.meta,
      });
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      // WR-05: let the app-level handler redirect on a stale-session mutation.
      // Without this re-throw, the user sees a generic "couldn't save" toast and
      // keeps clicking Save indefinitely; the actual cause is a logged-out session.
      if (err instanceof UnauthenticatedError) throw err;
      if (err instanceof ApiError && err.status === 409) {
        setCollisionError(err.message);
        setFocus('name');
      } else {
        onGenericError?.();
      }
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-panel border border-line rounded-md p-6 shadow-lg z-50 data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            Save as template
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-secondary leading-[1.5]">
            This captures the current entry&apos;s meta fields, summary, and body as a reusable template scoped to {entryType}. The template appears in the picker for future {entryType} entries.
          </Dialog.Description>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-3">
            <div>
              <label htmlFor="template-name" className="block text-sm mb-1">
                Template name
              </label>
              <input
                id="template-name"
                type="text"
                placeholder="e.g. Magic-System"
                autoFocus
                maxLength={80}
                {...register('name')}
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              />
              {errors.name && (
                <p role="alert" className="mt-1 text-sm text-red-500">
                  {errors.name.message}
                </p>
              )}
              {collisionError && (
                <p role="alert" className="mt-1 text-sm text-red-500">
                  {collisionError}
                </p>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-line-strong">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={createTemplate.isPending}
                className="px-3 py-1.5 text-sm rounded-md btn-accent disabled:opacity-50"
              >
                {createTemplate.isPending ? 'Saving…' : 'Save template'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default SaveAsTemplateDialog;
