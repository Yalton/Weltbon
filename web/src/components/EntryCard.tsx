import type { Entry } from '../hooks/useEntries';
import { EntryIdentity } from './EntryIdentity';
import { TypeBadge } from './TypeBadge';
import { WipPill } from './WipPill';

// Short last-edited date for the row: "Mar 4", or "Mar 4, 2025" outside the current year.
function shortDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function EntryCard({ entry }: { entry: Entry }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-3 md:flex-nowrap">
      <EntryIdentity entry={entry} />

      <TypeBadge type={entry.entryType} />

      {entry.wip === true && <WipPill wip />}

      {entry.summary && (
        // On phones the summary drops under the title (indented past the 36px medallion)
        // instead of being squeezed to a few characters.
        <span className="basis-full pl-12 text-sm text-ink-secondary truncate min-w-0 md:basis-auto md:flex-1 md:pl-0">
          {entry.summary}
        </span>
      )}

      {/* Desktop only: on a phone a long title already fills the first line, and the date
          would wrap onto a line of its own. */}
      <time
        dateTime={entry.updatedAt}
        title={`Last edited ${new Date(entry.updatedAt).toLocaleString()}`}
        className="hidden ml-auto shrink-0 text-sm text-ink-muted tabular md:block"
      >
        {shortDate(entry.updatedAt)}
      </time>
    </div>
  );
}
