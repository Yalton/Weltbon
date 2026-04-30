import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  SEVERITIES,
  useIssues,
  useUpdateIssue,
  useDeleteIssue,
  type Issue,
  type IssueFilters,
  type Severity,
} from '../hooks/useIssues';
import { SeverityPill } from '../components/SeverityPill';
import { IssueEditor } from '../components/IssueEditor';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';

type ResolutionFilter = 'open' | 'resolved' | 'all';

/**
 * Global issue triage route. Lists all issues across the universe with
 * severity + resolution filters, inline Resolve/Reopen toggle, and
 * Edit/Delete actions. Opens IssueEditor for create + edit.
 *
 * State choice: filters are local state (not URL) — URL-sync is a nice-to-have
 * but the ISS-05 contract only requires the filter surface itself. Keeping
 * state local keeps this plan tight; wire to useFilterParams in a follow-up
 * if operators ask to bookmark filtered triage views.
 */
export function IssuesView() {
  const { uid } = useParams<{ uid: string }>();

  const [severity, setSeverity] = useState<Severity | ''>('');
  const [resolutionFilter, setResolutionFilter] = useState<ResolutionFilter>('open');

  const filters: IssueFilters = useMemo(() => {
    const f: IssueFilters = {};
    if (severity) f.severity = severity;
    if (resolutionFilter === 'open') f.resolved = false;
    else if (resolutionFilter === 'resolved') f.resolved = true;
    return f;
  }, [severity, resolutionFilter]);

  const { data: issues, isLoading } = useIssues(uid!, filters);

  const updateIssue = useUpdateIssue(uid!);
  const deleteIssue = useDeleteIssue(uid!);

  const [editor, setEditor] = useState<{ open: boolean; initial: Issue | null }>({
    open: false,
    initial: null,
  });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const hasActiveFilters = severity !== '' || resolutionFilter !== 'open';

  const handleToggleResolved = (issue: Issue) => {
    updateIssue.mutate({
      id: issue.id,
      patch: { resolved: !issue.resolved },
    });
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    await deleteIssue.mutateAsync(deletingId);
    setDeletingId(null);
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Issues</h1>
        <button
          type="button"
          onClick={() => setEditor({ open: true, initial: null })}
          className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5"
        >
          New issue
        </button>
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="issues-severity" className="block text-xs text-neutral-500 mb-1">
            Severity
          </label>
          <select
            id="issues-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as Severity | '')}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm"
          >
            <option value="">All</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="issues-status" className="block text-xs text-neutral-500 mb-1">
            Status
          </label>
          <select
            id="issues-status"
            value={resolutionFilter}
            onChange={(e) => setResolutionFilter(e.target.value as ResolutionFilter)}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm"
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      {/* List */}
      <div className="mt-6">
        {isLoading ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : !issues || issues.length === 0 ? (
          hasActiveFilters ? (
            <EmptyState
              title="Nothing matches these filters"
              body="Try broadening your severity or status filter."
              action={
                <button
                  type="button"
                  onClick={() => { setSeverity(''); setResolutionFilter('open'); }}
                  className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
                >
                  Reset filters
                </button>
              }
            />
          ) : (
            <EmptyState
              title="Nothing flagged yet"
              body="Issues are open questions, contradictions, or gaps. File one from any entry's Issues section."
            />
          )
        ) : (
          <ul className="space-y-2">
            {issues.map((issue) => (
              <li
                key={issue.id}
                className="flex items-start gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 p-3"
              >
                <div className="mt-1">
                  <SeverityPill severity={issue.severity} />
                </div>

                <div className="flex-1 min-w-0">
                  <p className={issue.resolved ? 'font-medium line-through text-neutral-500' : 'font-medium'}>
                    {issue.title}
                  </p>
                  {issue.description && (
                    <p className="text-sm text-neutral-500 truncate">{issue.description}</p>
                  )}
                  {issue.entries.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {issue.entries.map((e) => (
                        <Link
                          key={e.id}
                          to={`/universes/${uid}/entries/${e.id}`}
                          className="inline-flex items-center rounded-full bg-neutral-200 dark:bg-neutral-800 px-2 py-0.5 text-xs hover:bg-neutral-300 dark:hover:bg-neutral-700"
                        >
                          {e.icon && <span className="mr-1">{e.icon}</span>}
                          {e.title}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => handleToggleResolved(issue)}
                    className="text-neutral-400 hover:text-neutral-200"
                  >
                    {issue.resolved ? 'Reopen' : 'Resolve'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditor({ open: true, initial: issue })}
                    className="text-neutral-400 hover:text-neutral-200"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeletingId(issue.id)}
                    className="text-neutral-400 hover:text-red-500"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Editor dialog */}
      <IssueEditor
        universeId={uid!}
        open={editor.open}
        onOpenChange={(open) => setEditor((prev) => ({ ...prev, open }))}
        initialIssue={editor.initial}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deletingId !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingId(null);
        }}
        title="Delete this issue?"
        body="The issue and all its entry associations will be removed. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}
