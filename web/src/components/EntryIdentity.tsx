import type { Entry } from '../hooks/useEntries';
import { Medallion } from './Medallion';

/**
 * The identity pair every entry row leads with: medallion + serif title.
 *
 * Extracted because EntryCard, PinnedEntryCard and DraggableEntryCard all render it
 * identically and must stay in sync — they have different wrappers and drag wiring,
 * so only this inner pair is shared. Deliberately renders a fragment (no wrapper div):
 * each call site owns its own flex row, drag ref and listeners.
 *
 * NOT for the map tooltip — that is a different layout (medallion + title + type badge
 * stacked in a column), not this pair.
 */
export function EntryIdentity({ entry }: { entry: Entry }) {
  return (
    <>
      <Medallion
        title={entry.title}
        entryType={entry.entryType}
        icon={entry.icon}
        coverThumbUrl={entry.coverThumbUrl}
        size="sm"
      />
      <span className="font-display font-semibold text-ink text-base leading-[1.5] truncate">
        {entry.title}
      </span>
    </>
  );
}
