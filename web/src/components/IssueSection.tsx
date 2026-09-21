import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EntryIssueRef } from '../hooks/useEntries';
import { useUpdateIssue, useUndismissIssue } from '../hooks/useIssues';
import { useUniverse } from '../hooks/useUniverse';
import { SeverityPill } from './SeverityPill';
import { AIBadge } from './AIBadge';
import { CategoryIcon, CATEGORY_STRIPE } from './CategoryIcon';
import { DismissAIIssueDialog } from './DismissAIIssueDialog';
import { IssueEditor } from './IssueEditor';
import { AuditCostDialog } from './AuditCostDialog';
import type { AuditCategory, Issue } from '../hooks/useIssues';

interface Props {
  universeId: string;
  entryId: string;
  issues: EntryIssueRef[];
  onChanged?: () => void;
}

export function IssueSection({ universeId, entryId, issues, onChanged }: Props) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [auditDialogOpen, setAuditDialogOpen] = useState(false);
  const [dismissing, setDismissing] = useState<EntryIssueRef | null>(null);

  const updateIssue = useUpdateIssue(universeId);
  const undismissIssue = useUndismissIssue(universeId);
  const { data: universe } = useUniverse(universeId);

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
        <div className="flex items-center gap-2">
          {universe?.auditEnabled === true && (
            <button
              type="button"
              onClick={() => setAuditDialogOpen(true)}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 inline-flex items-center gap-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800"
              aria-haspopup="dialog"
            >
              ⚖ Audit this entry
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
          >
            Flag issue
          </button>
        </div>
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


      {universe?.auditEnabled === true && (
        <AuditCostDialog
          open={auditDialogOpen}
          onOpenChange={setAuditDialogOpen}
          universeId={universeId}
          scope="entry"
          entryId={entryId}
        />
      )}

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
