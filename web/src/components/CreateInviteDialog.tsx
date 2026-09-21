
import { useState, useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useCreateInvite, type InviteWithPlaintext } from '../hooks/useInvites';

const schema = z.object({
  label: z.string().trim().min(1, 'Label is required').max(100, 'Maximum 100 characters'),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateInviteDialog({ open, onOpenChange }: Props) {
  const [phase, setPhase] = useState<'form' | 'reveal'>('form');
  const [tokenData, setTokenData] = useState<InviteWithPlaintext | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copyButtonRef = useRef<HTMLButtonElement>(null);

  const createInvite = useCreateInvite();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { label: '' },
  });

  // Reset all internal state when the dialog closes (UI-SPEC §8.5)
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setPhase('form');
      setTokenData(null);
      setCopied(false);
      setCopyError(false);
      reset();
    }
    onOpenChange(nextOpen);
  };


  useEffect(() => {
    if (phase === 'reveal') {
      copyButtonRef.current?.focus();
    }
  }, [phase]);

  const onSubmit = async (values: FormValues) => {
    try {
      const result = await createInvite.mutateAsync({ label: values.label });
      setTokenData(result);
      setPhase('reveal');
    } catch {
      // below renders it. react-hook-form keeps the form intact for retry.
    }
  };

  const handleCopy = async () => {
    if (!tokenData) return;
    try {
      await navigator.clipboard.writeText(tokenData.plaintext);
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg z-50 data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">

          {phase === 'form' ? (
            <>
              {/* Form phase — UI-SPEC §8.1 */}
              <Dialog.Title className="text-lg font-semibold">
                Create an invite code
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
                Invite codes let you onboard one new user. Give it a label so you remember who you shared it with.
              </Dialog.Description>

              <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-3">
                <div>
                  <label htmlFor="invite-label" className="block text-sm mb-1">
                    Label
                  </label>
                  <input
                    id="invite-label"
                    type="text"
                    placeholder="e.g. Alice's onboarding"
                    autoFocus
                    maxLength={100}
                    {...register('label')}
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
                  />
                  {errors.label && (
                    <p className="mt-1 text-sm text-red-500" role="alert">
                      {errors.label.message}
                    </p>
                  )}
                  {createInvite.error && (
                    <p className="mt-1 text-sm text-red-500" role="alert">
                      {(createInvite.error as Error).message}
                    </p>
                  )}
                </div>

                <div className="mt-6 flex justify-end gap-2">
                  <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700">
                    Cancel
                  </Dialog.Close>
                  <button
                    type="submit"
                    disabled={createInvite.isPending}
                    className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50"
                  >
                    {createInvite.isPending ? 'Creating…' : 'Create invite code'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              {/* Reveal phase — UI-SPEC §8.3 */}
              <Dialog.Title className="text-lg font-semibold">
                Save this invite code now
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
                This is the only time you&apos;ll see this code. Copy it and send it to the person you want to invite — once you close this dialog, it can&apos;t be retrieved.
              </Dialog.Description>

              {/* Invite-code display block — UI-SPEC §8.3 */}
              <div className="mt-4 rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-800 p-3">
                <code
                  className="font-mono text-sm leading-[1.5] break-all select-all text-neutral-900 dark:text-neutral-100"
                  aria-label="Your new invite code"
                >{tokenData?.plaintext}</code>
              </div>

              {/* Copy button — UI-SPEC §8.3 */}
              <button
                ref={copyButtonRef}
                type="button"
                onClick={handleCopy}
                className="mt-4 w-full bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                {copied ? 'Copied!' : 'Copy invite code'}
              </button>

              {/* Copy error fallback (UI-SPEC §8.3) */}
              {copyError && (
                <p className="mt-2 text-sm text-red-500" role="alert">
                  Couldn&apos;t copy. Select the code above and copy manually.
                </p>
              )}

              {/* aria-live region for screen readers (UI-SPEC §8.3) */}
              <span aria-live="polite" className="sr-only">
                {copied ? 'Invite code copied to clipboard' : ''}
              </span>

              {/* Done button — UI-SPEC §8.5 */}
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => handleOpenChange(false)}
                  className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700"
                >
                  Done
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
