import type { Entry } from '../hooks/useEntries';
import { TypeBadge } from './TypeBadge';

export function EntryCard({ entry }: { entry: Entry }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-md border border-neutral-200 dark:border-neutral-800 hover:border-[color:var(--color-accent)] transition-colors">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center text-xl">
        {entry.icon || (
          <span className="h-5 w-5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        )}
      </span>

      <span className="text-base leading-[1.5] truncate font-semibold">{entry.title}</span>

      <TypeBadge type={entry.entryType} />

      {entry.summary && (
        <span className="text-sm text-neutral-600 dark:text-neutral-400 truncate flex-1 min-w-0">
          {entry.summary}
        </span>
      )}
    </div>
  );
}
