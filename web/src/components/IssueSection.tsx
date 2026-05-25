import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EntryIssueRef } from '../hooks/useEntries';
import { useUpdateIssue, useUndismissIssue } from '../hooks/useIssues';
import { SeverityPill } from './SeverityPill';
import { AIBadge } from './AIBadge';
import { CategoryIcon, CATEGORY_STRIPE } from './CategoryIcon';
import { DismissAIIssueDialog } from './DismissAIIssueDialog';
import { IssueEditor } from './IssueEditor';
import type { AuditCategory, Issue } from '../hooks/useIssues';

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
 * Shows SeverityPill + title + Resolve quick-action for each open human issue.
 * A "Flag issue" button opens IssueEditor pre-populated with { entryIds:
 * [entryId] } so the user can raise a concern without leaving the entry.
 *
 * Phase 25 (D-05) — Minimal AI treatment:
 * AI rows show badge + category emoji + category-derived left-edge stripe + title
 * + Dismiss action (or Restore when dismissedAt != null, defense-in-depth) +
 * "View reasoning" link to global IssuesView. No ReasoningPanel embedded — the
 * reasoning UX is centralized on the global IssuesView.
 *
 * TODO: EntryIssueRef does not yet carry source/category/dismissedAt fields from
 * the API's EntryDetail projection. These are accessed via `(issue as any)` casts
 * until EntryIssueRef is extended to include Phase 25 AI fields (follow-up task).
 * The casts are safe at runtime as long as the API returns the AI fields in the
 * EntryDetail issues array (which it does per Plan 25-02's projection).
 *
 * Uses one useUpdateIssue instance with per-click { id, patch } — same
 * pattern as useUpdateCategory in CategoryManageDialog.
 */
export function IssueSection({ universeId, entryId, issues, onChanged }: Props) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [dismissing, setDismissing] = useState<EntryIssueRef | null>(null);

  const updateIssue = useUpdateIssue(universeId);
  const undismissIssue = useUndismissIssue(universeId);

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
          {issues.map((issue) => {
            const isAI = (issue as any).source === 'ai';
            const cat = (issue as any).category as AuditCategory | undefined;
            const isDismissed = Boolean((issue as any).dismissedAt);

            const stripeClass =
              isAI
                ? cat
                  ? CATEGORY_STRIPE[cat]
                  : 'border-l-neutral-300 dark:border-l-neutral-700'
                : '';

            return (
              <li
                key={issue.id}
                className={`flex items-center justify-between rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2 ${isAI ? `border-l-2 ${stripeClass}` : ''}`}
              >
                <span className="flex items-center gap-3">
                  {isAI && (
                    <>
                      <CategoryIcon category={cat} />
                      <AIBadge />
                    </>
                  )}
                  <SeverityPill severity={issue.severity} />
                  <span className="text-sm">{issue.title}</span>
                </span>

                {isAI ? (
                  /* AI row actions — defense-in-depth: Restore when already dismissed */
                  <span className="flex items-center gap-2">
                    {isDismissed ? (
                      <button
                        type="button"
                        onClick={() =>
                          undismissIssue.mutate(issue.id, { onSuccess: () => onChanged?.() })
                        }
                        className="text-xs text-neutral-400 hover:text-neutral-200"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDismissing(issue)}
                        className="text-xs text-neutral-400 hover:text-neutral-200"
                      >
                        Dismiss
                      </button>
                    )}
                    <Link
                      to={`/universes/${universeId}/issues`}
                      className="text-xs text-neutral-400 hover:text-neutral-200 ml-2"
                    >
                      View reasoning
                    </Link>
                  </span>
                ) : (
                  /* Human row — byte-identical to pre-Phase-25 Resolve action */
                  <button
                    type="button"
                    onClick={() => handleResolve(issue.id)}
                    className="text-xs text-neutral-400 hover:text-neutral-200"
                  >
                    Resolve
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <IssueEditor
        universeId={universeId}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initialEntryIds={[entryId]}
        onSaved={() => onChanged?.()}
      />

      {/* DismissAIIssueDialog — mounted at section level so dismissal works inline */}
      <DismissAIIssueDialog
        universeId={universeId}
        issue={dismissing as any as Issue | null}
        open={dismissing !== null}
        onOpenChange={(o) => {
          if (!o) setDismissing(null);
        }}
        onDismissed={() => {
          onChanged?.();
          setDismissing(null);
        }}
      />
    </div>
  );
}
