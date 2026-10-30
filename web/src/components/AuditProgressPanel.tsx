import { useEffect, useState } from 'react';
import { useAuditRun } from '../hooks/useAudits';
import { AuditStatusPill } from './AuditStatusPill';
import { AuditCompletionBanner } from './AuditCompletionBanner';
import { formatRelative } from '../utils/formatRelative';


export interface AuditProgressPanelProps {
  universeId: string;
  runId: string;
  variant?: 'dialog' | 'standalone';
}

export function AuditProgressPanel({
  universeId,
  runId,
  variant = 'standalone',
}: AuditProgressPanelProps) {
  const { data: run, isPending, error } = useAuditRun(universeId, runId);

  const [now, setNow] = useState<number>(() => Date.now());
  const inFlight =
    run?.status === 'pending' || run?.status === 'running' || (!run && !error);
  useEffect(() => {
    if (!inFlight) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [inFlight]);

  const containerClass =
    variant === 'standalone'
      ? 'p-4 border border-line rounded-md'
      : '';

  if (isPending && !run) {
    return (
      <div className={containerClass} aria-busy="true" aria-label="Loading audit run">
        <div className="h-6 w-40 rounded bg-raised animate-pulse" />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div
        role="alert"
        className={`${containerClass} text-sm text-red-700 dark:text-red-300`}
      >
        Could not load audit run.
      </div>
    );
  }

  // Terminal states — delegate to the completion banner (D-07). For "stale"
  // runs (succeeded > 30 min ago at re-open) we prepend a small muted line.
  if (run.status === 'succeeded' || run.status === 'failed') {
    const finishedAt = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
    const stale =
      run.status === 'succeeded' &&
      finishedAt !== null &&
      Date.now() - finishedAt > 30 * 60 * 1000;
    return (
      <div className={containerClass}>
        {stale && run.finishedAt && (
          <p className="text-xs text-ink-muted mb-2">
            {/* formatRelative already ends in "ago" (or reads "Just now"). */}
            Run finished {formatRelative(run.finishedAt).toLowerCase()}
          </p>
        )}
        <AuditCompletionBanner
          universeId={universeId}
          runId={runId}
          dismissible={variant === 'dialog'}
        />
      </div>
    );
  }

  const startedAtMs = new Date(run.startedAt).getTime();
  const elapsedSec = Math.max(0, Math.floor((now - startedAtMs) / 1000));

  return (
    <div className={containerClass}>
      <h3 className="text-base font-semibold inline-flex items-center gap-2">
        <span aria-hidden="true" className="animate-spin inline-block">⟳</span>
        Running audit…
      </h3>

      <div className="mt-3 space-y-2 text-sm">
        <div className="flex items-center gap-3">
          <AuditStatusPill status={run.status} />
        </div>
        <div className="tabular-nums text-ink-secondary">
          Elapsed: <span className="font-medium">{elapsedSec}s</span>
        </div>
        <div className="tabular-nums text-ink-secondary">
          Tool calls: <span className="font-medium">{run.toolCallCount}</span>
        </div>
        <div className="tabular-nums text-ink-secondary">
          Cost:{' '}
          <span aria-live="polite" aria-atomic="true" className="font-medium">
            ${run.costUsd}
          </span>
        </div>
      </div>
    </div>
  );
}
