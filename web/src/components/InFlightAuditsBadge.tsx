import * as Popover from '@radix-ui/react-popover';
import { Link } from 'react-router-dom';
import { useInFlightAudits } from '../hooks/useAudits';


export function InFlightAuditsBadge() {
  const { data: inFlight = [] } = useInFlightAudits();

  if (inFlight.length === 0) return null;

  return (
    <Popover.Root>
      <Popover.Trigger
        className="px-3 py-1.5 rounded-md hover:bg-white/5 text-sm inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        aria-label={`In-flight audits: ${inFlight.length}`}
        aria-haspopup="menu"
      >
        <span className="animate-pulse" aria-hidden="true">
          ⚖
        </span>{' '}
        <span className="tabular-nums">{inFlight.length}</span> running ▾
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="end"
          className="bg-panel border border-line rounded-md shadow-lg p-2 min-w-[320px] max-w-[calc(100vw-2rem)] z-50"
        >
          {inFlight.map((row) => {
            const elapsedSec = Math.floor(
              (Date.now() - new Date(row.startedAt).getTime()) / 1000,
            );
            return (
              <Link
                key={row.id}
                to={`/universes/${row.universeId}/settings?tab=audit-history`}
                className="block px-2 py-2 hover:bg-white/5 rounded text-left"
              >
                <div className="text-sm font-medium truncate">
                  {row.universeName}
                  {row.scopeEntryTitle
                    ? ` · entry: ${row.scopeEntryTitle}`
                    : ' · universe'}
                </div>
                <div className="text-xs text-ink-secondary tabular-nums mt-1">
                  {elapsedSec}s · {row.toolCallCount} tool calls · ~$
                  {row.costUsd}
                </div>
              </Link>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
