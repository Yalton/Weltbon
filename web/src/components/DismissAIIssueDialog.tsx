import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  useDismissIssue,
  SNOOZE_PRESETS,
  type Issue,
  type DismissalReason,
  type SnoozePreset,
} from '../hooks/useIssues';
import { HumanIssueTypeahead } from './HumanIssueTypeahead';

interface Props {
  universeId: string;
  issue: Issue | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismissed?: () => void;
}

/**
 * Two-step Dismiss modal for AI-sourced issues (D-01).
 *
 * Step 1: Pick one of 4 reasons via radio buttons.
 * Step 2: Reason-conditional follow-up:
 *   intentional             → plain confirm copy
 *   inaccurate              → optional notes textarea
 *   not_now                 → snooze-count preset picker (D-02)
 *   duplicate_of_human_issue → HumanIssueTypeahead
 *
 * Resets all local state when the dialog closes.
 *
 * Threat model T-25-05-01: no dangerouslySetInnerHTML — all content is text.
 * Threat model T-25-05-03: uses JWT bearer auth (not cookies) — CSRF-safe.
 */

const REASON_LABELS: Record<DismissalReason, string> = {
  intentional: 'I meant this gap',
  inaccurate: 'The AI is wrong',
  not_now: "I'll get to it later",
  duplicate_of_human_issue: 'Duplicate of existing issue',
};

const REASONS: DismissalReason[] = [
  'intentional',
  'inaccurate',
  'not_now',
  'duplicate_of_human_issue',
];

export function DismissAIIssueDialog({ universeId, issue, open, onOpenChange, onDismissed }: Props) {
  const [step, setStep] = useState<'step1' | 'step2'>('step1');
  const [reason, setReason] = useState<DismissalReason | null>(null);
  const [notes, setNotes] = useState('');
  const [snoozeRuns, setSnoozeRuns] = useState<SnoozePreset | null>(null);
  const [linkedIssueId, setLinkedIssueId] = useState<string | null>(null);
  const [linkedIssueLabel, setLinkedIssueLabel] = useState('');

  const dismiss = useDismissIssue(universeId);

  // Reset all local state when the dialog closes
  useEffect(() => {
    if (!open) {
      setStep('step1');
      setReason(null);
      setNotes('');
      setSnoozeRuns(null);
      setLinkedIssueId(null);
      setLinkedIssueLabel('');
      dismiss.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
  };

  const handleContinue = () => {
    if (!reason) return;
    setStep('step2');
  };

  const handleBack = () => {
    setStep('step1');
  };

  const isConfirmDisabled =
    dismiss.isPending ||
    (reason === 'duplicate_of_human_issue' && !linkedIssueId) ||
    (reason === 'not_now' && !snoozeRuns);

  const handleConfirm = () => {
    if (!issue || !reason) return;
    const payload: Record<string, unknown> = { id: issue.id, reason };
    if (reason === 'inaccurate' && notes.trim()) {
      payload.notes = notes.trim();
    }
    if (reason === 'not_now' && snoozeRuns) {
      payload.snoozeRuns = snoozeRuns;
    }
    if (reason === 'duplicate_of_human_issue' && linkedIssueId) {
      payload.linkedIssueId = linkedIssueId;
    }

    dismiss.mutate(payload as unknown as Parameters<ReturnType<typeof useDismissIssue>['mutate']>[0], {
      onSuccess: () => {
        onOpenChange(false);
        onDismissed?.();
      },
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            Dismiss AI suggestion
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {step === 'step1'
              ? 'Why are you dismissing this suggestion?'
              : reason === 'intentional'
              ? 'Confirm you want to permanently dismiss this suggestion.'
              : reason === 'inaccurate'
              ? "Optionally tell us what's wrong — this helps improve future suggestions."
              : reason === 'not_now'
              ? 'How many audit runs should we wait before resurfacing this?'
              : 'Which existing issue is this a duplicate of?'}
          </Dialog.Description>

          <div className="mt-4">
            {step === 'step1' ? (
              /* ─── Step 1: reason picker ─── */
              <fieldset>
                <legend className="sr-only">Dismissal reason</legend>
                <div className="space-y-2">
                  {REASONS.map((r) => (
                    <label
                      key={r}
                      className="flex items-center gap-3 cursor-pointer rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                    >
                      <input
                        type="radio"
                        name="dismiss-reason"
                        value={r}
                        checked={reason === r}
                        onChange={() => setReason(r)}
                        className="accent-[color:var(--color-accent)]"
                      />
                      <span className="text-sm">{REASON_LABELS[r]}</span>
                    </label>
                  ))}
                </div>

                <div className="mt-6 flex justify-end gap-2">
                  <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700">
                    Cancel
                  </Dialog.Close>
                  <button
                    type="button"
                    disabled={!reason}
                    onClick={handleContinue}
                    className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Continue
                  </button>
                </div>
              </fieldset>
            ) : (
              /* ─── Step 2: reason-conditional content ─── */
              <div>
                {reason === 'intentional' && (
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    This dismissal is permanent. The AI will never resurface this gap. You can undo
                    via Restore.
                  </p>
                )}

                {reason === 'inaccurate' && (
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    maxLength={2000}
                    rows={4}
                    placeholder="Optional: what's wrong about this suggestion?"
                    className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm resize-none"
                  />
                )}

                {reason === 'not_now' && (
                  <fieldset>
                    <legend className="sr-only">Snooze duration</legend>
                    <div className="flex flex-wrap gap-2">
                      {SNOOZE_PRESETS.map((p) => (
                        <label
                          key={p}
                          className="flex items-center gap-2 cursor-pointer rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        >
                          <input
                            type="radio"
                            name="snooze-preset"
                            value={p}
                            checked={snoozeRuns === p}
                            onChange={() => setSnoozeRuns(p)}
                            className="accent-[color:var(--color-accent)]"
                          />
                          <span className="text-sm">{p} runs</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}

                {reason === 'duplicate_of_human_issue' && (
                  <div>
                    <label className="block text-sm mb-1">Linked human issue</label>
                    <HumanIssueTypeahead
                      universeId={universeId}
                      value={linkedIssueLabel}
                      onChange={setLinkedIssueLabel}
                      onSelect={(selected) => {
                        setLinkedIssueId(selected.id);
                        setLinkedIssueLabel(selected.title);
                      }}
                    />
                  </div>
                )}

                {dismiss.isError && (
                  <p className="mt-2 text-sm text-red-500">
                    {dismiss.error instanceof Error
                      ? dismiss.error.message
                      : 'Failed to dismiss suggestion.'}
                  </p>
                )}

                <div className="mt-6 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={handleBack}
                    className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={isConfirmDisabled}
                    onClick={handleConfirm}
                    className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {dismiss.isPending ? 'Dismissing…' : 'Confirm'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
