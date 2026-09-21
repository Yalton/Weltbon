import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

// Locked copy block (UI-SPEC "Add Entries Picker" copy table).
const COPY = {
  title: 'Add entries',
  searchPlaceholder: 'Search entries...',
  emptySearch: (query: string) => `No entries match "${query}".`,
  addedBadge: 'Added',
  addButton: 'Add',
  removeButton: 'Remove from diagram',
  removeDialogTitle: 'Remove node?',
  removeDialogBody:
    'This removes the node from this diagram. The entry and its links in the force-directed graph are not affected.',
  removeDialogConfirm: 'Remove',
  close: 'Close add entries panel',
} as const;

export interface UniverseEntry {
  id: string;
  title: string;
  entryType: string;
}

export interface AddEntriesPickerProps {
  entries: UniverseEntry[];
  placedEntryIds: Set<string>;
  onAdd: (entryId: string) => void;
  onRemove: (entryId: string) => void;
  onClose: () => void;
  open: boolean;
}

export function AddEntriesPicker({
  entries,
  placedEntryIds,
  onAdd,
  onRemove,
  onClose,
  open,
}: AddEntriesPickerProps) {
  const [query, setQuery] = useState('');
  const [confirmEntry, setConfirmEntry] = useState<UniverseEntry | null>(null);

  const filtered = query.trim()
    ? entries.filter((e) =>
        e.title.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : entries;

  const handleRemoveConfirm = async () => {
    if (confirmEntry) {
      onRemove(confirmEntry.id);
    }
  };

  return (
    <>
      {/* Slide-in panel */}
      <div
        role="region"
        aria-label={COPY.title}
        className={[
          'absolute right-0 top-0 h-full w-72 z-20',
          'bg-white dark:bg-neutral-900',
          'border-l border-neutral-200 dark:border-neutral-800',
          'flex flex-col',
          'transition-transform duration-[180ms]',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        style={{ willChange: 'transform' }}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {COPY.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={COPY.close}
            className="rounded-md px-1.5 text-lg leading-none text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
          >
            ×
          </button>
        </div>

        {/* Search input */}
        <div className="px-4 py-2 shrink-0">
          <input
            type="text"
            aria-label="Search entries"
            placeholder={COPY.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
          />
        </div>

        {/* Entry list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 && query.trim() ? (
            <p className="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">
              {COPY.emptySearch(query.trim())}
            </p>
          ) : (
            <ul>
              {filtered.map((entry) => {
                const isPlaced = placedEntryIds.has(entry.id);
                return (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                  >
                    <span
                      className="text-sm text-neutral-900 dark:text-neutral-100 truncate flex-1"
                      title={entry.title}
                    >
                      {entry.title}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {isPlaced ? (
                        <>
                          <span className="text-xs text-neutral-400 dark:text-neutral-500 font-medium">
                            {COPY.addedBadge}
                          </span>
                          <button
                            type="button"
                            onClick={() => setConfirmEntry(entry)}
                            className="text-xs text-red-500 hover:text-red-700 whitespace-nowrap"
                          >
                            {COPY.removeButton}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onAdd(entry.id)}
                          className="text-xs rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-0.5 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        >
                          {COPY.addButton}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Destructive confirm dialog for "Remove from diagram" */}
      <ConfirmDialog
        open={confirmEntry !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setConfirmEntry(null);
        }}
        title={COPY.removeDialogTitle}
        body={COPY.removeDialogBody}
        confirmLabel={COPY.removeDialogConfirm}
        destructive
        onConfirm={handleRemoveConfirm}
      />
    </>
  );
}
