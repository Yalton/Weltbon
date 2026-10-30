import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  SEVERITIES,
  useCreateIssue,
  useUpdateIssue,
  type Issue,
  type Severity,
} from '../hooks/useIssues';

interface Props {
  universeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialIssue?: Issue | null;
  initialEntryIds?: string[];
  onSaved?: (issue: Issue) => void;
}

export function IssueEditor({
  universeId,
  open,
  onOpenChange,
  initialIssue = null,
  initialEntryIds = [],
  onSaved,
}: Props) {
  const isEdit = initialIssue !== null;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Severity>('moderate');
  const [error, setError] = useState<string | null>(null);

  const createIssue = useCreateIssue(universeId);
  const updateIssue = useUpdateIssue(universeId);

  // in create mode, show whichever entries the caller pre-populated.
  const entryChips = isEdit
    ? initialIssue?.entries.map((e) => ({ id: e.id, label: `${e.icon ?? ''} ${e.title}`.trim() })) ?? []
    : initialEntryIds.map((id) => ({ id, label: id.slice(0, 8) }));

  useEffect(() => {
    if (open) {
      setTitle(initialIssue?.title ?? '');
      setDescription(initialIssue?.description ?? '');
      setSeverity(initialIssue?.severity ?? 'moderate');
      setError(null);
    }
  }, [open, initialIssue]);

  const isPending = createIssue.isPending || updateIssue.isPending;
  const canSubmit =
    title.trim().length > 0 && title.trim().length <= 200 && !isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    try {
      if (isEdit && initialIssue) {
        const saved = await updateIssue.mutateAsync({
          id: initialIssue.id,
          patch: {
            title: title.trim(),
            description: description.trim(),
            severity,
          },
        });
        onSaved?.(saved);
      } else {
        const saved = await createIssue.mutateAsync({
          title: title.trim(),
          description: description.trim() || undefined,
          severity,
          entryIds: initialEntryIds.length > 0 ? initialEntryIds : undefined,
        });
        onSaved?.(saved);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save issue');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-panel border border-line rounded-md p-6 shadow-lg z-50">
          <Dialog.Title className="text-lg font-semibold">
            {isEdit ? 'Edit issue' : 'New issue'}
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            {isEdit
              ? 'Update the title, description, or severity of this issue.'
              : 'Flag a new issue. Add a title, optional description, and severity.'}
          </Dialog.Description>

          <form onSubmit={handleSubmit} className="mt-4 space-y-3">
            <div>
              <label htmlFor="issue-title" className="block text-sm mb-1">
                Title
              </label>
              <input
                id="issue-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                autoFocus
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="issue-description" className="block text-sm mb-1">
                Description (optional)
              </label>
              <textarea
                id="issue-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={3}
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label htmlFor="issue-severity" className="block text-sm mb-1">
                Severity
              </label>
              <select
                id="issue-severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as Severity)}
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            {entryChips.length > 0 && (
              <div>
                <p className="block text-sm mb-1">Associated entries</p>
                <div className="flex flex-wrap gap-1.5">
                  {entryChips.map((chip) => (
                    <span
                      key={chip.id}
                      className="inline-flex items-center rounded-full bg-raised px-2 py-0.5 text-xs"
                    >
                      {chip.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-red-500">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close
                type="button"
                className="px-3 py-1.5 text-sm rounded-md border border-line-strong"
              >
                Cancel
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSubmit}
                className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
