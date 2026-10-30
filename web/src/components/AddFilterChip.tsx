import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import type { EntryFilters } from '../hooks/useFilterParams';
import type { Category } from '../hooks/useCategories';
import type { FieldRegistryEntry } from '../types/fieldRegistry';
import { BooleanInput, EntryRefInput, UrlInput } from './MetaEditor';

export function AddFilterChip({
  universeId,
  filters,
  updateFilters,
  types,
  categories,
  registeredFields = [],
}: {
  universeId: string;
  filters: EntryFilters;
  updateFilters: (patch: Partial<EntryFilters>) => void;
  types: string[];
  categories: Category[];
  registeredFields?: FieldRegistryEntry[];
}) {
  const [open, setOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  const [selectedFieldName, setSelectedFieldName] = useState('');
  const [fieldValueDraft, setFieldValueDraft] = useState('');

  const selectedField =
    registeredFields.find((f) => f.name === selectedFieldName) ?? null;

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

  function handleWipChange(value: string) {
    if (value === '') {
      updateFilters({ wip: null });
    } else {
      updateFilters({ wip: value === 'true' });
    }
    setOpen(false);
  }

  function applyFieldFilter(value: string) {
    if (!selectedFieldName || !value) return;
    // D-08: one chip per field — re-adding overwrites the existing value.
    updateFilters({
      fieldFilters: {
        ...filters.fieldFilters,
        [selectedFieldName]: value,
      },
    });
    setSelectedFieldName('');
    setFieldValueDraft('');
    setOpen(false);
  }

  function handleFieldPickerChange(fieldName: string) {
    setSelectedFieldName(fieldName);
    setFieldValueDraft('');
  }

  const fieldValueInputId = 'add-filter-field-value';

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSelectedFieldName('');
          setFieldValueDraft('');
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Add filter"
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong text-ink-secondary px-3 py-1 text-sm hover:border-[color:var(--color-ink-muted)] hover:text-ink"
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

          {/* Status group — three-state WIP filter */}
          <div className="space-y-1">
            <span className="text-xs font-medium text-neutral-500">Status</span>
            <select
              aria-label="Add status filter"
              value={filters.wip === null ? '' : String(filters.wip)}
              onChange={(e) => handleWipChange(e.target.value)}
              className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
            >
              <option value="">All entries</option>
              <option value="true">WIP only</option>
              <option value="false">Finished only</option>
            </select>
          </div>

          {/* Fields group — only when the universe has registered fields */}
          {registeredFields.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs font-medium text-neutral-500">Fields</span>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-500">Field</span>
                <select
                  aria-label="Select field to filter"
                  value={selectedFieldName}
                  onChange={(e) => handleFieldPickerChange(e.target.value)}
                  className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
                >
                  <option value="" disabled>
                    Select field...
                  </option>
                  {registeredFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>

              {/* Typed value input — only after a field is picked. D-07: reuse
                  the MetaEditor typed inputs (BooleanInput / EntryRefInput /
                  UrlInput) so the value entry matches the field's type. */}
              {selectedField && (
                <div className="space-y-1">
                  <span className="text-xs font-medium text-neutral-500">Value</span>
                  {selectedField.type === 'boolean' ? (
                    <BooleanInput
                      inputId={fieldValueInputId}
                      name={`Add value for ${selectedField.name}`}
                      value={fieldValueDraft}
                      onChange={(v) => {
                        // Boolean is a tri-toggle that applies immediately on a
                        setFieldValueDraft(v);
                        if (v) applyFieldFilter(v);
                      }}
                    />
                  ) : selectedField.type === 'entry-ref' ? (
                    <EntryRefInput
                      inputId={fieldValueInputId}
                      name={`Add value for ${selectedField.name}`}
                      value={fieldValueDraft}
                      onChange={setFieldValueDraft}
                      universeId={universeId}
                    />
                  ) : selectedField.type === 'url' ? (
                    <UrlInput
                      inputId={fieldValueInputId}
                      value={fieldValueDraft}
                      onChange={setFieldValueDraft}
                    />
                  ) : (
                    <input
                      id={fieldValueInputId}
                      type={selectedField.type === 'number' ? 'number' : 'text'}
                      aria-label={`Add value for ${selectedField.name}`}
                      placeholder={
                        selectedField.type === 'number' ? '0' : 'Filter value...'
                      }
                      value={fieldValueDraft}
                      onChange={(e) => setFieldValueDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          applyFieldFilter(fieldValueDraft);
                        }
                      }}
                      className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
                    />
                  )}
                </div>
              )}

              {/* Apply button for the non-immediate inputs (boolean applies
                  on selection, so it needs no Apply button). */}
              {selectedField && selectedField.type !== 'boolean' && (
                <button
                  type="button"
                  onClick={() => applyFieldFilter(fieldValueDraft)}
                  disabled={!fieldValueDraft}
                  className="text-xs rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                >
                  Apply
                </button>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
