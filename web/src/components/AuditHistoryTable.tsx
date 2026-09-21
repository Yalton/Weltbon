import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuditHistory, type AuditHistoryRow } from '../hooks/useAudits';
import { AuditStatusPill } from './AuditStatusPill';
import { EMOJI } from './CategoryIcon';
import { EmptyState } from './EmptyState';
import { formatRelative } from '../utils/formatRelative';
import type { AuditCategory } from '../hooks/useIssues';


type SortKey = 'startedAt' | 'cost' | 'status';
type SortDir = 'asc' | 'desc';

export interface AuditHistoryTableProps {
  universeId: string;
  highlightRunId?: string;
}

export function AuditHistoryTable({
  universeId,
  highlightRunId,
}: AuditHistoryTableProps) {
  const { data, isPending, error } = useAuditHistory(universeId);
  const navigate = useNavigate();

  const [sortKey, setSortKey] = useState<SortKey>('startedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sortedRows = useMemo<AuditHistoryRow[]>(() => {
    if (!data?.rows) return [];
    const rows = [...data.rows];
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'startedAt') {
        cmp =
          new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
      } else if (sortKey === 'cost') {
        cmp = parseFloat(a.costUsd) - parseFloat(b.costUsd);
      } else if (sortKey === 'status') {
        cmp = a.status.localeCompare(b.status);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [data?.rows, sortKey, sortDir]);

  function navigateToRun(runId: string) {
    navigate(`/universes/${universeId}/issues?audit_run_id=${runId}`);
  }

  if (isPending) {
    return (
      <div
        className="mt-6 space-y-2"
        aria-busy="true"
        aria-label="Loading audit history"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-12 rounded-md bg-neutral-100 dark:bg-neutral-800 animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="mt-6 rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300"
      >
        Could not load audit history. Refresh the page to try again.
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <EmptyState
        title="No audit runs yet"
        body="Trigger one from the universe detail page or an entry's Issues section."
      />
    );
  }

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return '';
    return sortDir === 'desc' ? '↓' : '↑';
  }

  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">History of audit runs for this universe</caption>
        <thead>
          <tr className="border-b border-neutral-200 dark:border-neutral-800">
            <th
              scope="col"
              className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
            >
              <button
                type="button"
                onClick={() => toggleSort('startedAt')}
                className="inline-flex items-center gap-1 cursor-pointer"
              >
                Date {sortArrow('startedAt')}
              </button>
            </th>
            <th
              scope="col"
              className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
            >
              Scope
            </th>
            <th
              scope="col"
              className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
            >
              Model
            </th>
            <th
              scope="col"
              className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500"
            >
              <button
                type="button"
                onClick={() => toggleSort('cost')}
                className="inline-flex items-center gap-1 cursor-pointer"
              >
                Cost {sortArrow('cost')}
              </button>
            </th>
            <th
              scope="col"
              className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
            >
              Findings
            </th>
            <th
              scope="col"
              className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
            >
              <button
                type="button"
                onClick={() => toggleSort('status')}
                className="inline-flex items-center gap-1 cursor-pointer"
              >
                Status {sortArrow('status')}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const isHighlight = highlightRunId === row.id;
            const isFailed = row.status === 'failed';
            const absoluteDate = new Date(row.startedAt).toLocaleString();
            const findingsEntries = Object.entries(row.suggestionsByCategory) as [
              AuditCategory,
              number,
            ][];
            return (
              <tr
                key={row.id}
                role="link"
                tabIndex={0}
                onClick={() => navigateToRun(row.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigateToRun(row.id);
                  }
                }}
                className={`border-b border-neutral-100 dark:border-neutral-800 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer ${
                  isHighlight ? 'bg-neutral-100 dark:bg-neutral-800' : ''
                }`}
                aria-label={`Audit run from ${formatRelative(row.startedAt)}, ${row.scope}, status ${row.status}`}
              >
                <td className="py-3 pr-4 text-sm leading-[1.5]">
                  <time dateTime={row.startedAt} title={absoluteDate}>
                    {formatRelative(row.startedAt)}
                  </time>
                </td>
                <td className="py-3 pr-4 text-sm leading-[1.5]">
                  {row.scope === 'universe' ? (
                    'universe'
                  ) : (
                    <>
                      entry:{' '}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (row.scopeEntryId) {
                            navigate(
                              `/universes/${universeId}/entries/${row.scopeEntryId}`,
                            );
                          }
                        }}
                        className="underline"
                      >
                        {row.scopeEntryTitle ?? 'deleted entry'}
                      </button>
                    </>
                  )}
                </td>
                <td className="py-3 pr-4 text-sm leading-[1.5] text-neutral-700 dark:text-neutral-300">
                  {row.provider} / {row.model}

                  {row.credentialSource === 'shared' && (
                    <span className="ml-2 inline-block text-xs text-neutral-500 dark:text-neutral-400 border border-neutral-300 dark:border-neutral-700 rounded px-1.5 py-0.5 align-middle">
                      Shared connection
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4 text-sm leading-[1.5] tabular-nums text-right">

                  {row.costUnknown ? (
                    <span
                      className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded px-2 py-1"
                      aria-label="Cost unknown — the model used has no published rates"
                    >
                      cost unknown
                    </span>
                  ) : isFailed && parseFloat(row.costUsd) === 0 ? (
                    '—'
                  ) : (
                    `$${row.costUsd}`
                  )}
                </td>
                <td className="py-3 pr-4 text-sm leading-[1.5]">
                  {findingsEntries.length === 0 && isFailed
                    ? '—'
                    : findingsEntries.map(([cat, n]) => (
                        <span key={cat} className="mr-2">
                          {EMOJI[cat]} ×{n}
                        </span>
                      ))}
                </td>
                <td className="py-3 text-sm leading-[1.5]">
                  <AuditStatusPill status={row.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
