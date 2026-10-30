import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EntryIssueRef } from '../hooks/useEntries';
import { useUpdateIssue, useUndismissIssue } from '../hooks/useIssues';
import { useUniverse } from '../hooks/useUniverse';
import { SeverityPill } from './SeverityPill';
import { AIBadge } from './AIBadge';
import { CategoryIcon, Glyph } from './CategoryIcon';
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
    <div className="mt-6 pt-6 border-t border-line">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Issues ({issues.length})</h2>
        <div className="flex items-center gap-2">
          {universe?.auditEnabled === true && (
            <button
              type="button"
              onClick={() => setAuditDialogOpen(true)}
              className="rounded-md border border-line-strong text-sm px-3 py-1.5 inline-flex items-center gap-1.5 hover:bg-white/5"
              aria-haspopup="dialog"
            >
              <Glyph name="scale" />
              Audit this entry
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            className="rounded-md border border-line-strong text-sm px-3 py-1.5"
          >
            Flag issue
          </button>
        </div>
      </div>

      {issues.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          No open issues for this entry.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {issues.map((issue) => {
            const isAI = (issue as any).source === 'ai';
            const cat = (issue as any).category as AuditCategory | undefined;
            const isDismissed = Boolean((issue as any).dismissedAt);


            return (
              <li
                key={issue.id}
                className="flex items-center justify-between rounded-md border border-line bg-panel px-3 py-2"
              >
                <span className="flex items-center gap-3">
                  {isAI && (
                    <>
                      <span className="text-xs text-ink-secondary">
                        <CategoryIcon category={cat} withLabel />
                      </span>
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
                        className="text-xs text-ink-muted hover:text-ink-muted"
                      >
                        Restore
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDismissing(issue)}
                        className="text-xs text-ink-muted hover:text-ink-muted"
                      >
                        Dismiss
                      </button>
                    )}
                    <Link
                      to={`/universes/${universeId}/issues`}
                      className="text-xs text-ink-muted hover:text-ink-muted ml-2"
                    >
                      View reasoning
                    </Link>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleResolve(issue.id)}
                    className="text-xs text-ink-muted hover:text-ink-muted"
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
