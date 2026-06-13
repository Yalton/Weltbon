import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { EntryFilters } from '../hooks/useFilterParams';
import type { Category } from '../hooks/useCategories';

/**
 * "+ Filter" chip that opens a Radix Popover to pick a new filter value for
 * type, tag, or category. v1 uses native selects for type/category and a
 * freeform text input for tags (tag strings are arbitrary in the data
 * model — deriving suggestions from existing entries is a future polish).
 */
export function AddFilterChip({
  filters,
  updateFilters,
  types,
  categories,
}: {
  universeId: string;
  filters: EntryFilters;
  updateFilters: (patch: Partial<EntryFilters>) => void;
  types: string[];
  categories: Category[];
}) {
  const [open, setOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  function addType(t: string) {
    if (!t) return;
    updateFilters({ type: t });
    setOpen(false);
  }
  function addTag(t: string) {
    const clean = t.trim();
    if (!clean) return;
    if (filters.tags.includes(clean)) {
      setTagDraft('');
      return;
    }
    updateFilters({ tags: [...filters.tags, clean] });
    setTagDraft('');
    setOpen(false);
  }
  function addCategory(c: string) {
    if (!c) return;
    updateFilters({ category: c });
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Add filter"
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-400 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 px-3 py-1 text-sm hover:border-neutral-600 dark:hover:border-neutral-400"
        >
          + Filter
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 w-64 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-3 shadow-lg text-sm space-y-3"
        >
          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-500">Type</span>
            <select
              aria-label="Add type filter"
              defaultValue=""
              onChange={(e) => addType(e.target.value)}
              className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
            >
              <option value="" disabled>
                Select type...
              </option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-500">Tag</span>
            <input
              type="text"
              aria-label="Add tag filter"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag(tagDraft);
                }
              }}
              placeholder="Type tag, press Enter"
              className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-neutral-500">Category</span>
            <select
              aria-label="Add category filter"
              defaultValue=""
              onChange={(e) => addCategory(e.target.value)}
              className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
            >
              <option value="" disabled>
                Select category...
              </option>
              <option value="uncategorized">Uncategorized</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
