import { Link } from 'react-router-dom';
import type { Issue } from '../hooks/useIssues';

interface Props {
  issue: Issue;
  expanded: boolean;
  uid: string;
}

/**
 * Inline accordion panel rendered below an AI issue row in IssuesView (D-04).
 *
 * When expanded=false, renders null (no DOM node — parent controls toggle).
 * When expanded=true, shows: Model, Cost, consulted-entries chip grid, rationale.
 *
 * Threat model T-25-05-01: all interpolated content (rationale, entry titles,
 * model name) is rendered as React text nodes (never innerHTML) — XSS-safe.
 */
export function ReasoningPanel({ issue, expanded, uid }: Props) {
  if (!expanded) return null;

  const costFormatted = `$${Number(issue.costUsd ?? 0).toFixed(4)}`;

  return (
    <div className="mt-2 ml-7 rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-3 text-sm">
      {/* Model + Cost header */}
      <div className="flex items-center gap-4 text-xs text-neutral-500">
        <span>
          Model:{' '}
          <span className="font-mono text-neutral-700 dark:text-neutral-300">
            {issue.model ?? '—'}
          </span>
        </span>
        <span>
          Cost:{' '}
          <span className="font-mono text-neutral-700 dark:text-neutral-300">
            {costFormatted}
          </span>
        </span>
      </div>

      {/* Consulted entries */}
      <div className="mt-2 text-xs text-neutral-500 mb-1">
        Consulted entries ({issue.consultedEntries?.length ?? 0}):
      </div>
      {!issue.consultedEntries || issue.consultedEntries.length === 0 ? (
        <p className="text-xs text-neutral-400 italic">
          No tool-call trail recorded for this run.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
          {issue.consultedEntries.map((e) => (
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

      {/* Rationale paragraph */}
      <p className="mt-3 text-sm whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
        {issue.rationale ?? issue.description}
      </p>
    </div>
  );
}
