import { useState, useRef, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEntries, type Entry } from '../hooks/useEntries';
import { useCreateLink } from '../hooks/useLinks';
import { TypeBadge } from './TypeBadge';

interface Props {
  universeId: string;
  entryId: string;
  onLinkCreated: () => void;
  children: ReactNode;
}

export function LinkEditor({ universeId, entryId, onLinkCreated, children }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
  const [label, setLabel] = useState('');
  const [bidirectional, setBidirectional] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: entries } = useEntries(universeId);
  const createLink = useCreateLink(universeId);

  // Filter entries client-side, exclude self
  const filtered = (entries ?? [])
    .filter((e) => e.id !== entryId)
    .filter((e) => e.title.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 8);

  const canSubmit = selectedEntry !== null && label.trim().length > 0;

  const reset = () => {
    setSearch('');
    setSelectedEntry(null);
    setLabel('');
    setBidirectional(false);
    setShowDropdown(false);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await createLink.mutateAsync({
      sourceEntryId: entryId,
      targetEntryId: selectedEntry.id,
      label: label.trim(),
      bidirectional,
    });
    reset();
    setOpen(false);
    onLinkCreated();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) reset();
  };

  const handleSelect = (entry: Entry) => {
    setSelectedEntry(entry);
    setSearch(entry.title);
    setShowDropdown(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="w-80 p-4 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50"
          sideOffset={8}
          align="start"
        >
          <div className="space-y-3">
            {/* Target entry search */}
            <div>
              <label className="block text-sm text-neutral-400 mb-1">Link to entry</label>
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSelectedEntry(null);
                  setShowDropdown(true);
                }}
                onFocus={() => setShowDropdown(true)}
                placeholder="Search entries..."
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
              />
              {showDropdown && search.length > 0 && filtered.length > 0 && (
                <ul className="mt-1 max-h-48 overflow-y-auto border border-neutral-200 dark:border-neutral-800 rounded-md bg-white dark:bg-neutral-900">
                  {filtered.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => handleSelect(entry)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        {entry.icon && <span>{entry.icon}</span>}
                        <span className="truncate flex-1">{entry.title}</span>
                        <TypeBadge type={entry.entryType} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Relation label */}
            <div>
              <label className="block text-sm text-neutral-400 mb-1">Relation</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder='e.g. "created by"'
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
              />
            </div>

            {/* Bidirectional toggle */}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={bidirectional}
                onChange={(e) => setBidirectional(e.target.checked)}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm">Bidirectional</span>
                <p className="text-xs text-neutral-400">Both entries will show this link</p>
              </div>
            </label>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => handleOpenChange(false)}
                className="text-sm px-3 py-1.5 text-neutral-400 hover:text-neutral-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit || createLink.isPending}
                className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createLink.isPending ? 'Adding...' : 'Add link'}
              </button>
            </div>
          </div>
          <Popover.Arrow className="fill-neutral-200 dark:fill-neutral-800" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
