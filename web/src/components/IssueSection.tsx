import { useState } from 'react';
import type { EntryIssueRef } from '../hooks/useEntries';
import { useUpdateIssue } from '../hooks/useIssues';
import { SeverityPill } from './SeverityPill';
import { IssueEditor } from './IssueEditor';

interface Props {
  universeId: string;
  entryId: string;
  /** Open issues attached to this entry (from EntryDetail response, ISS-06). */
  issues: EntryIssueRef[];
  onChanged?: () => void;
}

/**
 * Per-entry issue list rendered on EntryDetail below LinkSection.
 *
 * Shows SeverityPill + title + Resolve quick-action for each open issue.
 * A "Flag issue" button opens IssueEditor pre-populated with { entryIds:
 * [entryId] } so the user can raise a concern without leaving the entry.
 *
 * Uses one useUpdateIssue instance with per-click { id, patch } — same
 * pattern as useUpdateCategory in CategoryManageDialog.
 */
export function IssueSection({ universeId, entryId, issues, onChanged }: Props) {
  const [editorOpen, setEditorOpen] = useState(false);
  const updateIssue = useUpdateIssue(universeId);

  const handleResolve = (issueId: string) => {
    updateIssue.mutate(
      { id: issueId, patch: { resolved: true } },
      { onSuccess: () => onChanged?.() },
    );
  };

  return (
    <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Issues ({issues.length})</h2>
        <button
          type="button"
          onClick={() => setEditorOpen(true)}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
        >
          Flag issue
        </button>
      </div>

      {issues.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">
          No open issues for this entry.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {issues.map((issue) => (
            <li
              key={issue.id}
              className="flex items-center justify-between rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2"
            >
              <span className="flex items-center gap-3">
                <SeverityPill severity={issue.severity} />
                <span className="text-sm">{issue.title}</span>
              </span>
              <button
                type="button"
                onClick={() => handleResolve(issue.id)}
                className="text-xs text-neutral-400 hover:text-neutral-200"
              >
                Resolve
              </button>
            </li>
          ))}
        </ul>
      )}

      <IssueEditor
        universeId={universeId}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initialEntryIds={[entryId]}
        onSaved={() => onChanged?.()}
      />
    </div>
  );
}
