import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AUDIT_CATEGORIES,
  SEVERITIES,
  useIssues,
  useUpdateIssue,
  useDeleteIssue,
  useUndismissIssue,
  type AuditCategory,
  type Issue,
  type IssueFilters,
  type Severity,
} from '../hooks/useIssues';
import { useUniverse } from '../hooks/useUniverse';
import { SeverityPill } from '../components/SeverityPill';
import { AIBadge } from '../components/AIBadge';
import { CategoryIcon, CATEGORY_STRIPE } from '../components/CategoryIcon';
import { ReasoningPanel } from '../components/ReasoningPanel';
import { DismissAIIssueDialog } from '../components/DismissAIIssueDialog';
import { IssueEditor } from '../components/IssueEditor';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Toast } from '../components/Toast';
import { AuditCompletionBanner } from '../components/AuditCompletionBanner';
import { Loading } from '../components/ui/Loading';

const AUDIT_RUN_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResolutionFilter = 'open' | 'resolved' | 'dismissed' | 'all';

export function IssuesView() {
  const { uid } = useParams<{ uid: string }>();

  // URL-only filter (no UI control); set by completion-banner CTA + audit-
  // history row click. UUID guard is defense-in-depth alongside server Zod.
  const [searchParams, setSearchParams] = useSearchParams();
  const auditRunIdRaw = searchParams.get('audit_run_id');
  const safeAuditRunId =
    auditRunIdRaw && AUDIT_RUN_ID_UUID_RE.test(auditRunIdRaw)
      ? auditRunIdRaw
      : undefined;
  const clearAuditFilter = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('audit_run_id');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const { data: universe } = useUniverse(uid);
  const auditEnabled = universe?.auditEnabled === true;

  const [severity, setSeverity] = useState<Severity | ''>('');
  const [resolutionFilter, setResolutionFilter] = useState<ResolutionFilter>('open');
  const [sourceFilter, setSourceFilter] = useState<'both' | 'human' | 'ai'>('both');
  const [categoryFilter, setCategoryFilter] = useState<Set<AuditCategory>>(new Set());

  const [expandedReasoning, setExpandedReasoning] = useState<Map<string, boolean>>(new Map());
  const [dismissingIssue, setDismissingIssue] = useState<Issue | null>(null);
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null);

  // ── Server-side filter construction ──────────────────────────────────────
  const serverFilters: IssueFilters = useMemo(() => {
    const f: IssueFilters = {};
    if (severity) f.severity = severity;
    if (sourceFilter !== 'both') f.source = sourceFilter;
    if (resolutionFilter === 'open') {
      f.resolved = false;
      f.includeDismissed = false;
    } else if (resolutionFilter === 'resolved') {
      f.resolved = true;
    }
    if (categoryFilter.size > 0) {
      f.category = Array.from(categoryFilter);
    }
    if (safeAuditRunId) f.auditRunId = safeAuditRunId;
    return f;
  }, [severity, resolutionFilter, sourceFilter, categoryFilter, safeAuditRunId]);

  const { data: issues, isLoading } = useIssues(uid!, serverFilters);

  const updateIssue = useUpdateIssue(uid!);
  const deleteIssue = useDeleteIssue(uid!);
  const undismissIssue = useUndismissIssue(uid!);

  const [editor, setEditor] = useState<{ open: boolean; initial: Issue | null }>({
    open: false,
    initial: null,
  });
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── Client-side filter pass ───────────────────────────────────────────────
  const displayedIssues = useMemo(() => {
    if (!issues) return [];
    return issues.filter((i) => {
      if (sourceFilter === 'human' && i.source === 'ai') return false;
      if (sourceFilter === 'ai' && i.source !== 'ai') return false;
      if (resolutionFilter === 'open' && i.dismissedAt) return false;
      if (resolutionFilter === 'dismissed' && (!i.dismissedAt || i.source !== 'ai')) return false;
      // CR-04: was `(i.source === 'ai' || !i.resolved)` which unconditionally hid all AI
      // determine eligibility for both human and AI sources (D-09: Resolved = resolved===true).
      if (resolutionFilter === 'resolved' && !i.resolved) return false;
      if (
        categoryFilter.size > 0 &&
        (!i.category || !categoryFilter.has(i.category as AuditCategory))
      )
        return false;
      return true;
    });
  }, [issues, sourceFilter, resolutionFilter, categoryFilter]);

  const hasActiveFilters =
    severity !== '' ||
    resolutionFilter !== 'open' ||
    sourceFilter !== 'both' ||
    categoryFilter.size > 0;

  const handleToggleResolved = (issue: Issue) => {
    updateIssue.mutate({ id: issue.id, patch: { resolved: !issue.resolved } });
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    await deleteIssue.mutateAsync(deletingId);
    setDeletingId(null);
  };

  const toggleReasoning = (id: string) => {
    setExpandedReasoning((prev) => {
      const next = new Map(prev);
      next.set(id, !(next.get(id) ?? false));
      return next;
    });
  };

  const toggleCategory = (cat: AuditCategory) => {
    setCategoryFilter((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleRestore = (issue: Issue) => {
    undismissIssue.mutate(issue.id, {
      onSuccess: () => setToast({ message: 'Suggestion restored.', variant: 'success' }),
      onError: () =>
        setToast({ message: 'Failed to restore suggestion.', variant: 'error' }),
    });
  };

  // the "✕ Clear filter" button per UI-SPEC §Accessibility). Listener is
  // dialogs or other Esc-bound surfaces.
  useEffect(() => {
    if (!safeAuditRunId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearAuditFilter();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [safeAuditRunId, clearAuditFilter]);

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

      {/* Filters — left-to-right: Severity → Source → Category → Status (D-10) */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        {/* Severity */}
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

        {/* Source (D-10) */}
        <div>
          <label htmlFor="issues-source" className="block text-xs text-neutral-500 mb-1">
            Source
          </label>
          <select
            id="issues-source"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as 'both' | 'human' | 'ai')}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm"
          >
            <option value="both">Both</option>
            <option value="human">Human</option>
            <option value="ai">AI</option>
          </select>
        </div>

        {/* Category multi-select (D-10) — greyed out when Source=Human */}
        <div className={sourceFilter === 'human' ? 'opacity-50 pointer-events-none' : ''}>
          <span className="block text-xs text-neutral-500 mb-1">Category</span>
          <div className="flex flex-wrap gap-2">
            {AUDIT_CATEGORIES.map((cat) => (
              <label
                key={cat}
                className="inline-flex items-center gap-1.5 text-xs cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={categoryFilter.has(cat)}
                  onChange={() => toggleCategory(cat)}
                  disabled={sourceFilter === 'human'}
                  className="accent-[color:var(--color-accent)]"
                />
                <span>
                  <CategoryIcon category={cat} /> {cat}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Status (D-09) */}
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
            <option value="dismissed">Dismissed</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>


      {safeAuditRunId && uid && (
        <div className="mt-6">
          <AuditCompletionBanner
            universeId={uid}
            runId={safeAuditRunId}
            dismissible={false}
            onClearFilter={clearAuditFilter}
          />
        </div>
      )}

      {/* List */}
      <div className="mt-6">
        {isLoading ? (
          <Loading />
        ) : !displayedIssues || displayedIssues.length === 0 ? (
          safeAuditRunId ? (
            <EmptyState
              title="No suggestions from this run"
              body="Try clearing the run filter to see all suggestions."
              action={
                <button
                  type="button"
                  onClick={clearAuditFilter}
                  className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
                >
                  ✕ Clear filter
                </button>
              }
            />
          ) : resolutionFilter === 'dismissed' ? (
            <EmptyState
              title="No dismissed AI suggestions"
              body="No dismissed AI suggestions. They're filtered out of audit runs and won't burn tokens."
            />
          ) : hasActiveFilters ? (
            <EmptyState
              title="Nothing matches these filters"
              body="Try broadening your severity or status filter."
              action={
                <button
                  type="button"
                  onClick={() => {
                    setSeverity('');
                    setResolutionFilter('open');
                    setSourceFilter('both');
                    setCategoryFilter(new Set());
                  }}
                  className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
                >
                  Reset filters
                </button>
              }
            />
          ) : (
            // nudge below the empty-state — only when the universe has NOT
            // so already-opted-in users don't see a redundant prompt.
            <>
              <EmptyState
                title="Nothing flagged yet"
                body="Issues are open questions, contradictions, or gaps. File one from any entry's Issues section."
              />
              {!auditEnabled && uid && (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-3 italic text-center">
                  Or let AI surface gaps for you —{' '}
                  <Link
                    to={`/universes/${uid}/settings?tab=ai-auditor`}
                    className="underline text-[color:var(--color-accent)]"
                  >
                    Enable AI Gap Auditor in universe settings
                  </Link>
                </p>
              )}
            </>
          )
        ) : (
          <ul className="space-y-2">
            {displayedIssues.map((issue) => {
              const isAI = issue.source === 'ai';
              const stripeClass = isAI
                ? issue.category
                  ? CATEGORY_STRIPE[issue.category as AuditCategory]
                  : 'border-l-neutral-300 dark:border-l-neutral-700'
                : '';
              const isExpanded = expandedReasoning.get(issue.id) ?? false;

              return (
                <li
                  key={issue.id}
                  className={`rounded-md border border-neutral-200 dark:border-neutral-800 p-3 ${isAI ? `border-l-2 ${stripeClass}` : ''}`}
                >
                  {/* Row content */}
                  <div className="flex items-start gap-3">
                    {/* Severity pill + optional AI badge */}
                    <div className="mt-1 flex items-center gap-1.5 shrink-0">
                      <SeverityPill severity={issue.severity} />
                      {isAI && <AIBadge />}
                    </div>

                    {/* Title + description + entry chips */}
                    <div className="flex-1 min-w-0">
                      <p
                        className={
                          issue.resolved
                            ? 'font-medium line-through text-neutral-500'
                            : 'font-medium'
                        }
                      >
                        {isAI && issue.category && (
                          <>
                            <CategoryIcon category={issue.category} />{' '}
                          </>
                        )}
                        {issue.title}
                        {/* D-03: "AI flagged this too" chip on human rows */}
                        {!isAI && (issue.linkedByAiIssueIds?.length ?? 0) > 0 && (
                          <Link
                            to={`/universes/${uid}/issues`}
                            className="ml-2 inline-flex items-center rounded-full bg-neutral-200 dark:bg-neutral-700 px-1.5 py-0.5 text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-300 dark:hover:bg-neutral-600"
                            title="An AI suggestion was dismissed as a duplicate of this issue"
                          >
                            AI flagged this too
                          </Link>
                        )}
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

                    {/* Action group */}
                    <div className="flex items-center gap-2 text-xs shrink-0">
                      {isAI ? (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleReasoning(issue.id)}
                            className="text-neutral-400 hover:text-neutral-200"
                          >
                            {isExpanded ? 'Hide' : 'Why?'}
                          </button>
                          {!issue.dismissedAt && (
                            <button
                              type="button"
                              onClick={() => setDismissingIssue(issue)}
                              className="text-neutral-400 hover:text-neutral-200"
                            >
                              Dismiss
                            </button>
                          )}
                          {issue.dismissedAt && (
                            <button
                              type="button"
                              onClick={() => handleRestore(issue)}
                              className="text-neutral-400 hover:text-neutral-200"
                            >
                              Restore
                            </button>
                          )}
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>

                  {/* ReasoningPanel — outside the flex container but inside <li> so stripe wraps it */}
                  {isAI && (
                    <ReasoningPanel
                      issue={issue}
                      expanded={isExpanded}
                      uid={uid!}
                    />
                  )}
                </li>
              );
            })}
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

      {/* Dismiss AI suggestion dialog */}
      <DismissAIIssueDialog
        universeId={uid!}
        issue={dismissingIssue}
        open={dismissingIssue !== null}
        onOpenChange={(o) => {
          if (!o) setDismissingIssue(null);
        }}
        onDismissed={() => setToast({ message: 'Suggestion dismissed.', variant: 'success' })}
      />

      {/* Toast notifications */}
      {toast && (
        <Toast message={toast.message} variant={toast.variant} onDismiss={() => setToast(null)} />
      )}
    </div>
  );
}
