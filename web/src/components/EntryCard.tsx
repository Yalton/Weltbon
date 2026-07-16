import type { Entry } from '../hooks/useEntries';
import { EntryIdentity } from './EntryIdentity';
import { TypeBadge } from './TypeBadge';
import { WipPill } from './WipPill';

export function EntryCard({ entry }: { entry: Entry }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-md border border-glass-border hover:border-[color:var(--color-accent)] transition-colors">
      <EntryIdentity entry={entry} />

      <TypeBadge type={entry.entryType} />

      {/* Phase 36 DATA-03 — non-interactive WIP badge on the entry list
          (SC2/DATA-03: pill visible on detail AND list). Port 9b82f27:18. */}
      {entry.wip === true && <WipPill wip />}

      {entry.summary && (
        <span className="text-sm text-ink-secondary truncate flex-1 min-w-0">
          {entry.summary}
        </span>
      )}
    </div>
  );
}
