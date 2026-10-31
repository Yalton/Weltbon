
import { useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  useCreateLlmKey,
  useReplaceLlmKey,
  type LlmProvider,
} from '../hooks/useLlmKeys';
import { ApiError } from '../api/client';

const createSchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  label: z.string().trim().max(100, 'Maximum 100 characters').optional(),
  key: z.string().trim().min(1, 'Key is required'),
});

const replaceSchema = z.object({
  provider: z.enum(['anthropic', 'openai']),
  label: z.string().trim().max(100, 'Maximum 100 characters').optional(),
  key: z.string().trim().min(1, 'Key is required'),
});

type FormValues = z.infer<typeof createSchema>;

export interface CreateLlmKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replaceTarget?: { id: string; provider: LlmProvider; label: string } | null;
  onCreated?: () => void;
}

export function CreateLlmKeyDialog({
  open,
  onOpenChange,
  replaceTarget = null,
  onCreated,
}: CreateLlmKeyDialogProps) {
  const isReplace = replaceTarget !== null;
  const createMutation = useCreateLlmKey();
  const replaceMutation = useReplaceLlmKey();
  const activeMutation = isReplace ? replaceMutation : createMutation;

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(isReplace ? replaceSchema : createSchema),
    defaultValues: {
      provider: replaceTarget?.provider ?? 'anthropic',
      label: replaceTarget?.label ?? '',
      key: '',
    },
  });

  // Re-seed the form whenever the replace target changes.
  useEffect(() => {
    if (replaceTarget) {
      setValue('provider', replaceTarget.provider);
      setValue('label', replaceTarget.label);
      setValue('key', '');
    }
  }, [replaceTarget, setValue]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // T-22-05-01: clear the paste box + provider/label on close so the
      reset({ provider: 'anthropic', label: '', key: '' });
      createMutation.reset();
      replaceMutation.reset();
    }
    onOpenChange(nextOpen);
  };

  const onSubmit = async (values: FormValues) => {
    try {
      if (isReplace && replaceTarget) {
        await replaceMutation.mutateAsync({
          id: replaceTarget.id,
          key: values.key,
          label: values.label,
        });
      } else {
        await createMutation.mutateAsync({
          provider: values.provider,
          key: values.key,
          label: values.label,
        });
      }
      reset({ provider: 'anthropic', label: '', key: '' });
      onCreated?.();
      onOpenChange(false);
    } catch {
    }
  };

  const errMessage =
    activeMutation.error instanceof ApiError
      ? activeMutation.error.message
      : activeMutation.error
        ? 'Could not reach the server. Check your connection and try again.'
        : null;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-panel border border-line rounded-md p-6 shadow-lg z-50 data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            {isReplace ? 'Replace LLM API key' : 'Add an LLM API key'}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-secondary leading-[1.5]">
            {isReplace
              ? 'Paste the new key to replace the existing one. The provider stays the same.'
              : 'Paste an Anthropic or OpenAI API key. Weltbon validates it against the provider, then stores it encrypted.'}
          </Dialog.Description>

          {/* WR-04 fix: force-remount the form whenever the replace target
              changes so React Hook Form's defaultValues are re-captured fresh
              instead of relying on the post-mount useEffect re-seed. Without
              this, a brief paint cycle would show provider='anthropic' / label=''
              before the effect rewrote the values (visible under Strict Mode
              double-render). The 'create' literal keeps the form mounted as a
              single instance when no replaceTarget is set. */}
          <form key={replaceTarget?.id ?? 'create'} onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-3">
            {/* Provider — locked in replace mode */}
            <div>
              <label htmlFor="llmkey-provider" className="block text-sm mb-1">
                Provider
              </label>
              <select
                id="llmkey-provider"
                disabled={isReplace}
                {...register('provider')}
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm disabled:opacity-60"
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
              </select>
              {errors.provider && (
                <p className="mt-1 text-sm text-red-500" role="alert">
                  {errors.provider.message}
                </p>
              )}
            </div>

            {/* Label (optional) */}
            <div>
              <label htmlFor="llmkey-label" className="block text-sm mb-1">
                Label (optional)
              </label>
              <input
                id="llmkey-label"
                type="text"
                placeholder="e.g. personal Anthropic key"
                maxLength={100}
                autoComplete="off"
                {...register('label')}
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              />
              {errors.label && (
                <p className="mt-1 text-sm text-red-500" role="alert">
                  {errors.label.message}
                </p>
              )}
            </div>

            {/* Key (plaintext) */}
            <div>
              <label htmlFor="llmkey-key" className="block text-sm mb-1">
                API key
              </label>
              <input
                id="llmkey-key"
                type="text"
                placeholder="sk-…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                {...register('key')}
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm font-mono"
              />
              {errors.key && (
                <p className="mt-1 text-sm text-red-500" role="alert">
                  {errors.key.message}
                </p>
              )}
            </div>

            {/* Server error — verbatim string from the response */}
            {errMessage && (
              <p
                className="mt-1 text-sm text-red-500 leading-[1.4]"
                role="alert"
                data-testid="llmkey-server-error"
              >
                {errMessage}
              </p>
            )}

            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-line-strong">
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={activeMutation.isPending}
                className="px-3 py-1.5 text-sm rounded-md btn-accent disabled:opacity-50"
              >
                {activeMutation.isPending
                  ? isReplace
                    ? 'Replacing…'
                    : 'Saving…'
                  : isReplace
                    ? 'Replace key'
                    : 'Save key'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
