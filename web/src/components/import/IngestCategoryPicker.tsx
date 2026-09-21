import { useState } from 'react';
import { useCategories } from '../../hooks/useCategories';

interface IngestCategoryPickerProps {
  universeId: string;
  value: { existingId: string } | { newName: string } | null;
  onChange: (value: { existingId: string } | { newName: string } | null) => void;
  id?: string;
}

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
      return;
    }
    onChange({ existingId: next });
  }

  function commitNewName() {
    const trimmed = newNameDraft.trim();
    if (trimmed === '') {
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
          aria-label="New category name"
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
