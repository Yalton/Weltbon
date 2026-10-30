import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { useFilteredEntries } from '../hooks/useFilteredEntries';
import type { Entry } from '../hooks/useEntries';
import type { TimelinePin } from '../hooks/useTimelinePins';
import { EntryIdentity } from './EntryIdentity';
import { TypeBadge } from './TypeBadge';
import { Loading } from './ui/Loading';


interface PanelFilters {
  q: string;
  type: string | null;
  tags: string[];
  category: string | null;
  // three-state wip + fieldFilters keys. The timeline panel does not surface
  // PanelFilters shape (zero coupling to the URL-bound EntryFilters module per
  wip: boolean | null;
  fieldFilters: Record<string, string>;
}

export interface TimelineEntryPanelProps {
  universeId: string;
  pins: TimelinePin[];
}

const EMPTY_FILTERS: PanelFilters = {
  q: '',
  type: null,
  tags: [],
  category: null,
  wip: null,
  fieldFilters: {},
};

function hasActiveFilter(f: PanelFilters): boolean {
  return !!f.q || !!f.type || f.tags.length > 0 || !!f.category;
}

interface CardProps {
  entry: Entry;
  isPinned: boolean;
}

function PinnedEntryCard({ entry }: CardProps) {
  return (
    <div
      data-testid={`timeline-entry-card-${entry.id}`}
      aria-disabled="true"
      className="flex items-center gap-3 px-4 py-3 rounded-md border border-line"
    >
      <EntryIdentity entry={entry} />
      <TypeBadge type={entry.entryType} />
      <span
        aria-label="Already pinned to timeline"
        className="ml-auto bg-raised text-ink-muted text-xs rounded px-2 py-1"
      >
        Pinned
      </span>
    </div>
  );
}

function DraggableEntryCard({ entry }: CardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: entry.id,
  });
  return (
    <div
      ref={setNodeRef}
      data-testid={`timeline-entry-card-${entry.id}`}
      className={`flex items-center gap-3 px-4 py-3 rounded-md border border-line cursor-grab hover:border-[color:var(--color-accent)] transition-colors ${
        isDragging ? 'opacity-50' : ''
      }`}
      {...attributes}
      {...listeners}
    >
      <EntryIdentity entry={entry} />
      <TypeBadge type={entry.entryType} />
    </div>
  );
}

export function TimelineEntryPanel({ universeId, pins }: TimelineEntryPanelProps) {
  const [filters, setFilters] = useState<PanelFilters>(EMPTY_FILTERS);
  const { data: entries, isLoading } = useFilteredEntries(universeId, filters);

  const pinnedEntryIds = useMemo(
    () => new Set(pins.map((p) => p.entryId)),
    [pins],
  );

  const list = entries ?? [];
  const filtersActive = hasActiveFilter(filters);

  return (
    <aside
      aria-label="Universe entries"
      className="w-80 flex-shrink-0 overflow-y-auto border-l border-line p-4 space-y-3"
    >
      <input
        type="search"
        value={filters.q}
        onChange={(e) =>
          setFilters((f) => ({ ...f, q: e.target.value }))
        }
        placeholder="Search entries..."
        aria-label="Search entries"
        className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
      />

      {isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        filtersActive ? (
          <div className="py-6 text-center">
            <p className="text-sm font-semibold text-ink">
              Nothing matches these filters
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Try removing a filter or clearing the search.
            </p>
          </div>
        ) : (
          <div className="py-6 text-center">
            <p className="text-sm font-semibold text-ink">
              No entries
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Add entries to this universe before pinning them to the timeline.
            </p>
          </div>
        )
      ) : (
        <ul className="space-y-2">
          {list.map((entry) => {
            const isPinned = pinnedEntryIds.has(entry.id);
            return (
              <li key={entry.id}>
                {isPinned ? (
                  <PinnedEntryCard entry={entry} isPinned />
                ) : (
                  <DraggableEntryCard entry={entry} isPinned={false} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
