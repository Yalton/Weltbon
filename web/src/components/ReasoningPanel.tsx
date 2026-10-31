import { Link } from 'react-router-dom';
import type { Issue } from '../hooks/useIssues';

interface Props {
  issue: Issue;
  expanded: boolean;
  uid: string;
}

export function ReasoningPanel({ issue, expanded, uid }: Props) {
  if (!expanded) return null;

  const costFormatted = `$${Number(issue.costUsd ?? 0).toFixed(4)}`;

  return (
    <div className="mt-2 ml-7 rounded-md border border-line bg-panel p-3 text-sm">
      {/* Model + Cost header */}
      <div className="flex items-center gap-4 text-xs text-ink-muted">
        <span>
          Model:{' '}
          <span className="font-mono text-ink">
            {issue.model ?? '—'}
          </span>
        </span>
        <span>
          Cost:{' '}
          <span className="font-mono text-ink">
            {costFormatted}
          </span>
        </span>
      </div>

      {/* Consulted entries */}
      <div className="mt-2 text-xs text-ink-muted mb-1">
        Consulted entries ({issue.consultedEntries?.length ?? 0}):
      </div>
      {!issue.consultedEntries || issue.consultedEntries.length === 0 ? (
        <p className="text-xs text-ink-secondary italic">
          No tool-call trail recorded for this run.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
          {issue.consultedEntries.map((e) => (
            <Link
              key={e.id}
              to={`/universes/${uid}/entries/${e.id}`}
              className="inline-flex items-center rounded-full bg-raised px-2 py-0.5 text-xs hover:bg-white/10"
            >
              {e.icon && <span className="mr-1">{e.icon}</span>}
              {e.title}
            </Link>
          ))}
        </div>
      )}

      {/* Rationale paragraph */}
      <p className="mt-3 text-sm whitespace-pre-wrap text-ink">
        {issue.rationale ?? issue.description}
      </p>
    </div>
  );
}
