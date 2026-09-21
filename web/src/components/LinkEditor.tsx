import { useState, useRef, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEntries, type Entry } from '../hooks/useEntries';
import { useCreateLink, usePatchLink } from '../hooks/useLinks';
import { TypeBadge } from './TypeBadge';
import { RelationCombobox } from './RelationCombobox';
import { LinkTypeSelect } from './LinkTypeSelect';

interface Props {
  universeId: string;
  entryId: string;
  onLinkCreated: () => void;
  children: ReactNode;
  editLink?: {
    id: string;
    label: string | null;
    linkType: string | null;
    direction: string;
  };
}

export function LinkEditor({ universeId, entryId, onLinkCreated, children, editLink }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
  const [label, setLabel] = useState('');
  const [linkType, setLinkType] = useState('');
  const [direction, setDirection] = useState<'directed' | 'undirected'>('directed');
  const [showDropdown, setShowDropdown] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: entries } = useEntries(universeId);
  const createLink = useCreateLink(universeId);
  const patchLink = usePatchLink(universeId);
  const isEditing = editLink !== undefined;

  // Filter entries client-side, exclude self
  const filtered = (entries ?? [])
    .filter((e) => e.id !== entryId)
    .filter((e) => e.title.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 8);

  // canSubmit: only requires a target entry (label and type are optional per D-04)
  const canSubmit = isEditing || selectedEntry !== null;

  const reset = () => {
    setSearch('');
    setSelectedEntry(null);
    setLabel(editLink?.label ?? '');
    setLinkType(editLink?.linkType ?? '');
    setDirection(editLink?.direction === 'undirected' ? 'undirected' : 'directed');
    setShowDropdown(false);
    setError(null);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    // mirror CreateLinkPopover's inline-error treatment rather than inventing a
    try {
      setError(null);
      if (editLink) {
        await patchLink.mutateAsync({
          linkId: editLink.id,
          label: label.trim() || null,
          linkType: linkType || null,
          direction,
        });
      } else if (selectedEntry) {
        await createLink.mutateAsync({
          sourceEntryId: entryId,
          targetEntryId: selectedEntry.id,
          label: label.trim() || null,
          linkType: linkType || null,
          direction,
        });
      }
    } catch (err) {
      setError(err);
      return;
    }
    reset();
    setOpen(false);
    onLinkCreated();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    reset();
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
            {/* Endpoints are immutable while editing: a different target is a new relationship. */}
            {!isEditing && <div>
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
            </div>}

            {/* Link type selection */}
            <div>
              <label className="block text-sm text-neutral-400 mb-1">Type</label>
              <LinkTypeSelect
                universeId={universeId}
                value={linkType}
                onChange={setLinkType}
                onDirectionChange={setDirection}
                placeholder="Search or enter a type..."
              />
            </div>

            {/* Direction toggle pill group (UI-SPEC Surface 2) */}
            <div>
              <label className="block text-sm text-neutral-400 mb-1">Direction</label>
              <div className="flex gap-1 mt-1" role="group" aria-label="Direction">
                <button
                  type="button"
                  aria-pressed={direction === 'directed'}
                  onClick={() => setDirection('directed')}
                  className={`rounded-md border px-3 py-1 text-sm cursor-pointer ${
                    direction === 'directed'
                      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
                      : 'border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400'
                  }`}
                >
                  A &rarr; B
                </button>
                <button
                  type="button"
                  aria-pressed={direction === 'undirected'}
                  onClick={() => setDirection('undirected')}
                  className={`rounded-md border px-3 py-1 text-sm cursor-pointer ${
                    direction === 'undirected'
                      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
                      : 'border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400'
                  }`}
                >
                  A &harr; B
                </button>
              </div>
            </div>

            {/* Display label (optional — demoted from required primary position) */}
            <div>
              <label className="block text-sm text-neutral-400 mb-1">
                Display label (optional)
              </label>
              <RelationCombobox
                universeId={universeId}
                value={label}
                onChange={setLabel}
                placeholder="e.g. sworn shield since the Sundering"
              />
            </div>

            {error != null && (
              <p className="text-xs text-red-500">
                Couldn&apos;t {isEditing ? 'save changes to' : 'create'} link. Try again.
              </p>
            )}

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
                disabled={!canSubmit || createLink.isPending || patchLink.isPending}
                className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createLink.isPending || patchLink.isPending
                  ? (isEditing ? 'Saving...' : 'Adding...')
                  : (isEditing ? 'Save changes' : 'Add link')}
              </button>
            </div>
          </div>
          <Popover.Arrow className="fill-neutral-200 dark:fill-neutral-800" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
