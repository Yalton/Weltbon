/**
 * CreateShareLinkDialog — Phase 29 owner-side mint dialog.
 *
 * Single Radix Dialog with two internal phases (mirrors CreateTokenDialog):
 *   'form'   — label input + expiry dropdown → POST /api/shares
 *   'reveal' — one-time `shareUrl` display + Copy + aria-live announcement
 *
 * UI-SPEC §E divergences from CreateTokenDialog (deliberate, documented):
 *   - Dialog.Title sizing: `text-xl font-semibold` (20px/600) NOT `text-lg`
 *     (18px). The Phase 29 typography scale declares only 4 sizes; 18px is
 *     not declared.
 *   - aria-live region: `assertive` (not `polite`) — the one-time URL reveal
 *     is a higher-stakes moment than the PAT reveal.
 *   - Form fields: a native `<select>` for expiresInDays (NOT Radix Select)
 *     matching the existing UniverseSettings provider/model dropdowns.
 *   - Reveal phase label: "Save this link now" / "Copy link" (matches
 *     UI-SPEC §Copywriting Contract verbatim).
 *
 * T-29-31 one-time reveal: `tokenData` lives only in component state and is
 * cleared on every dialog close (`handleOpenChange`). The plaintext URL is
 * never persisted to localStorage / sessionStorage / browser history — the
 * URL leaves memory when the dialog closes.
 */

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  useCreateShareLink,
  type ShareExpiryDays,
  type ShareLinkWithUrl,
} from '../hooks/useShares';

const schema = z.object({
  label: z.string().trim().max(100, 'Maximum 100 characters'),
});

type FormValues = z.infer<typeof schema>;

type ExpiryOption = '' | '7' | '30' | '90' | '180' | '365';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
}

export function CreateShareLinkDialog({ open, onOpenChange, universeId }: Props) {
  const [phase, setPhase] = useState<'form' | 'reveal'>('form');
  const [tokenData, setTokenData] = useState<ShareLinkWithUrl | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<ExpiryOption>('');

  const copyButtonRef = useRef<HTMLButtonElement>(null);

  const createShareLink = useCreateShareLink();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { label: '' },
  });

  // Reset all internal state when the dialog closes — T-29-31 enforces that
  // the shareUrl never persists past dialog close.
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setPhase('form');
      setTokenData(null);
      setCopied(false);
      setCopyError(null);
      setSubmitError(null);
      setExpiry('');
      reset();
    }
    onOpenChange(nextOpen);
  };

  // Focus the Copy button when phase transitions to 'reveal' (UI-SPEC §E
  // accessibility checklist).
  useEffect(() => {
    if (phase === 'reveal') {
      copyButtonRef.current?.focus();
    }
  }, [phase]);

  const onSubmit = async (values: FormValues) => {
    setSubmitError(null);
    const expiresInDays: ShareExpiryDays =
      expiry === '' ? null : (Number(expiry) as 7 | 30 | 90 | 180 | 365);
    try {
      const result = await createShareLink.mutateAsync({
        universeId,
        label: values.label,
        expiresInDays,
      });
      setTokenData(result);
      setPhase('reveal');
    } catch {
      // UI-SPEC §Copywriting Contract §Error States verbatim.
      setSubmitError("Couldn't create share link. Try again.");
    }
  };

  const handleCopy = async () => {
    if (!tokenData) return;
    try {
      await navigator.clipboard.writeText(tokenData.shareUrl);
      setCopied(true);
      setCopyError(null);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // UI-SPEC §Copywriting Contract §Error States verbatim.
      setCopyError("Couldn't copy. Select the URL above and copy manually.");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          {phase === 'form' ? (
            <>
              {/* Form phase — UI-SPEC §E. text-xl (20px) is the deliberate
                  divergence from CreateTokenDialog's text-lg (18px) to keep
                  the spec within its 4-size scale. */}
              <Dialog.Title className="text-xl font-semibold">
                Create a share link
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
                Give this link a label so you can identify it later. Anyone with the link can browse the public entries in this universe.
              </Dialog.Description>

              <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-3">
                <div>
                  <label htmlFor="share-label" className="block text-sm mb-1">
                    Label
                  </label>
                  <input
                    id="share-label"
                    type="text"
                    placeholder="e.g. close friends, dev notes"
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
                </div>

                <div>
                  <label htmlFor="share-expiry" className="block text-sm mb-1">
                    Expiry
                  </label>
                  {/* UI-SPEC §E: native <select> NOT Radix Select — matches
                      existing UniverseSettings provider/model dropdowns. */}
                  <select
                    id="share-expiry"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value as ExpiryOption)}
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
                  >
                    <option value="">No expiry</option>
                    <option value="7">7 days</option>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                    <option value="180">180 days</option>
                    <option value="365">365 days</option>
                  </select>
                </div>

                {submitError && (
                  <p className="text-sm text-red-500" role="alert">
                    {submitError}
                  </p>
                )}

                <div className="mt-6 flex justify-end gap-2">
                  <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700">
                    Close
                  </Dialog.Close>
                  <button
                    type="submit"
                    disabled={createShareLink.isPending}
                    className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50"
                  >
                    {createShareLink.isPending ? 'Creating…' : 'Create link'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <>
              {/* Reveal phase — UI-SPEC §E. */}
              <Dialog.Title className="text-xl font-semibold">
                Save this link now
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
                This is the only time you&apos;ll see this URL. Copy it somewhere safe — it won&apos;t be shown again.
              </Dialog.Description>

              {/* URL display block — UI-SPEC §E. */}
              <div className="mt-4 rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-800 p-3">
                <code
                  className="font-mono text-sm leading-[1.5] break-all select-all text-neutral-900 dark:text-neutral-100"
                  aria-label="Your new share link URL"
                >
                  {tokenData?.shareUrl}
                </code>
              </div>

              {/* Copy button — UI-SPEC §E. Auto-focused on phase transition. */}
              <button
                ref={copyButtonRef}
                type="button"
                onClick={handleCopy}
                className="mt-4 w-full bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                {copied ? 'Copied!' : 'Copy link'}
              </button>

              {/* aria-live region — UI-SPEC §E divergence from CreateTokenDialog:
                  `assertive` (NOT `polite`) because the one-time reveal is a
                  higher-stakes moment than the PAT reveal. */}
              <span aria-live="assertive" className="sr-only">
                {phase === 'reveal'
                  ? 'Share link created. Copy it now — it won’t be shown again.'
                  : ''}
              </span>

              {/* Copy error fallback — UI-SPEC §Copywriting Contract verbatim. */}
              {copyError && (
                <p className="mt-2 text-sm text-red-500" role="alert">
                  {copyError}
                </p>
              )}

              {/* Done button. */}
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
