import { useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { useFilteredEntries } from '../hooks/useFilteredEntries';
import type { Entry } from '../hooks/useEntries';
import type { TimelinePin } from '../hooks/useTimelinePins';
import { EntryIdentity } from './EntryIdentity';
import { TypeBadge } from './TypeBadge';
import { Loading } from './ui/Loading';

/**
 * TimelineEntryPanel — the right-hand list of every universe entry in the
 * timeline view (TIMELINE-04, Phase 20 D-10).
 *
 * Drag source ONLY. The drop target lives at the parent (TimelineView,
 * wired in Plan 20-06). This panel does not mount its own drag context so
 * it can be reused inside any drag-context-providing parent.
 *
 * Filter state is LOCAL useState — deliberately decoupled from the URL
 * (RESEARCH §Pitfall 3 / §Q7). The sibling entry-list view uses URL-bound
 * filter params for shareable filter state; timeline filtering is a
 * sub-view of the timeline, not a routable surface.
 *
 * Pinned entries (those with an existing TimelinePin) display a non-draggable
 * "Pinned" badge per D-10. Repositioning an existing pin is done on the
 * canvas (drag the pin itself, TIMELINE-06), not via the panel.
 *
 * Desktop-only (D-12): the activationConstraint distance=5 sensor lives at
 * the parent drag context; touch users see the panel but drag gestures
 * effectively no-op. Matches Phase 19 D-04 defer-touch.
 *
 * Filter shape mirrors the URL-bound entry-filter interface; we inline the
 * type here rather than importing it so the panel has zero coupling to the
 * URL-bound module (intentionally avoided per §Pitfall 3).
 */

interface PanelFilters {
  q: string;
  type: string | null;
  tags: string[];
  category: string | null;
  // Phase 36 DATA-04 — useFilteredEntries' EntryFilters now requires the
  // three-state wip + fieldFilters keys. The timeline panel does not surface
  // those controls, so they stay inert (null / {}) here; we keep the local
  // PanelFilters shape (zero coupling to the URL-bound EntryFilters module per
  // §Pitfall 3) but mirror its structural contract so the call typechecks.
  wip: boolean | null;
  fieldFilters: Record<string, string>;
}

export interface TimelineEntryPanelProps {
  /** Universe id — feeds useFilteredEntries. */
  universeId: string;
  /** Pins from the parent's useTimelinePins query — used to compute isPinned. */
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

/**
 * Card subcomponent. Splits the pinned vs. unpinned rendering so we only
 * call useDraggable on cards that should actually be drag sources — calling
 * a hook conditionally would violate React's rules-of-hooks, so the parent
 * decides which subcomponent to mount.
 */
function PinnedEntryCard({ entry }: CardProps) {
  return (
    <div
      data-testid={`timeline-entry-card-${entry.id}`}
      aria-disabled="true"
      className="flex items-center gap-3 px-4 py-3 rounded-md border border-neutral-200 dark:border-neutral-800"
    >
      <EntryIdentity entry={entry} />
      <TypeBadge type={entry.entryType} />
      <span
        aria-label="Already pinned to timeline"
        className="ml-auto bg-neutral-100 dark:bg-neutral-800 text-neutral-500 text-xs rounded px-2 py-1"
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
      className={`flex items-center gap-3 px-4 py-3 rounded-md border border-neutral-200 dark:border-neutral-800 cursor-grab hover:border-[color:var(--color-accent)] transition-colors ${
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
      className="w-80 flex-shrink-0 overflow-y-auto border-l border-neutral-200 dark:border-neutral-800 p-4 space-y-3"
    >
      <input
        type="search"
        value={filters.q}
        onChange={(e) =>
          setFilters((f) => ({ ...f, q: e.target.value }))
        }
        placeholder="Search entries..."
        aria-label="Search entries"
        className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
      />

      {isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        filtersActive ? (
          <div className="py-6 text-center">
            <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              Nothing matches these filters
            </p>
            <p className="mt-1 text-xs text-neutral-500">
              Try removing a filter or clearing the search.
            </p>
          </div>
        ) : (
          <div className="py-6 text-center">
            <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
              No entries
            </p>
            <p className="mt-1 text-xs text-neutral-500">
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
