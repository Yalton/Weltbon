import { useState } from 'react';
import { useCategories } from '../../hooks/useCategories';

interface IngestCategoryPickerProps {
  universeId: string;
  /**
   * Either an existing-category id, an in-flight new-name string, or null
   * (uncategorized). Caller owns the value.
   */
  value: { existingId: string } | { newName: string } | null;
  onChange: (value: { existingId: string } | { newName: string } | null) => void;
  id?: string;
}

/**
 * Existing-OR-new category picker for the markdown import review pane.
 *
 * Wraps the EntryCategoryPicker recipe (native <select>) and adds a
 * "+ Create category" option that swaps to an autoFocus text input. New
 * names are committed via onChange on blur or Enter; Escape cancels.
 *
 * D-26 / UI-SPEC §5.3.
 */
export function IngestCategoryPicker({
  universeId,
  value,
  onChange,
  id,
}: IngestCategoryPickerProps) {
  const { data } = useCategories(universeId);

  const [mode, setMode] = useState<'select' | 'create'>(
    value !== null && 'newName' in value ? 'create' : 'select',
  );
  const [newNameDraft, setNewNameDraft] = useState<string>(
    value !== null && 'newName' in value ? value.newName : '',
  );

  const selectValue =
    value === null
      ? ''
      : 'existingId' in value
        ? value.existingId
        : '__new__';

  function handleSelectChange(next: string) {
    if (next === '') {
      onChange(null);
      return;
    }
    if (next === '__new__') {
      setMode('create');
      setNewNameDraft('');
      // Do NOT call onChange yet — wait for user to commit a name.
      return;
    }
    onChange({ existingId: next });
  }

  function commitNewName() {
    const trimmed = newNameDraft.trim();
    if (trimmed === '') {
      // empty draft = cancel
      setMode('select');
      onChange(null);
      return;
    }
    onChange({ newName: trimmed });
  }

  function cancelCreate() {
    setMode('select');
    setNewNameDraft('');
    onChange(null);
  }

  if (mode === 'create') {
    return (
      <div>
        <input
          id={id}
          autoFocus
          type="text"
          value={newNameDraft}
          onChange={(e) => setNewNameDraft(e.target.value)}
          onBlur={() => commitNewName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitNewName();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelCreate();
            }
          }}
          placeholder="New category name"
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
        />
        <p className="text-xs text-emerald-500 mt-1">Will be created</p>
      </div>
    );
  }

  return (
    <select
      id={id}
      value={selectValue}
      onChange={(e) => handleSelectChange(e.target.value)}
      className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
    >
      <option value="">Uncategorized</option>
      {data?.categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.icon ? `${c.icon} ` : ''}
          {c.label}
        </option>
      ))}
      <option value="__new__">+ Create category</option>
    </select>
  );
}
