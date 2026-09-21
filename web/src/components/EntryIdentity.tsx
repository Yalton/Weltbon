import type { Entry } from '../hooks/useEntries';
import { Medallion } from './Medallion';

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
