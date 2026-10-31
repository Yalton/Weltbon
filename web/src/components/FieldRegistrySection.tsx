import { useState } from 'react';
import { useUpdateUniverse, type FieldRegistryEntry } from '../hooks/useUniverse';
import type { Universe } from '../hooks/useUniverse';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  universe: Universe;
}

const FIELD_TYPE_OPTIONS: { value: FieldRegistryEntry['type']; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'url', label: 'URL' },
  { value: 'entry-ref', label: 'Entry reference' },
];

export function FieldRegistrySection({ universe }: Props) {
  const update = useUpdateUniverse(universe.id);

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<FieldRegistryEntry['type'] | ''>('');
  const [newHint, setNewHint] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<FieldRegistryEntry['type'] | ''>('');
  const [editHint, setEditHint] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const registry = universe.fieldRegistry ?? [];

  const submitAdd = async () => {
    const trimmedName = newName.trim();
    setAddError(null);

    if (!trimmedName) {
      setAddError('Field name is required.');
      return;
    }
    if (trimmedName.length > 50) {
      setAddError('Field name is too long (max 50 characters).');
      return;
    }
    if (!newType) {
      setAddError('Field type is required.');
      return;
    }

    // Case-insensitive uniqueness check
    const duplicate = registry.some(
      (f) => f.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (duplicate) {
      setAddError('A field with this name already exists.');
      return;
    }

    const entry: FieldRegistryEntry = { name: trimmedName, type: newType };
    if (newHint.trim()) entry.hint = newHint.trim();

    const next = [...registry, entry];
    setSaveStatus('idle');
    try {
      await update.mutateAsync({ fieldRegistry: next });
      setNewName('');
      setNewType('');
      setNewHint('');
      setSaveStatus('success');
    } catch {
      setSaveStatus('error');
    }
  };

  const startEdit = (field: FieldRegistryEntry) => {
    setEditingName(field.name);
    setEditName(field.name);
    setEditType(field.type);
    setEditHint(field.hint ?? '');
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingName(null);
    setEditError(null);
  };

  const commitEdit = async () => {
    const trimmedName = editName.trim();
    setEditError(null);

    if (!trimmedName) {
      setEditError('Field name is required.');
      return;
    }
    if (trimmedName.length > 50) {
      setEditError('Field name is too long (max 50 characters).');
      return;
    }
    if (!editType) {
      setEditError('Field type is required.');
      return;
    }

    // Check uniqueness — allow same-name (no change), reject conflicts with others
    const conflict = registry.some(
      (f) =>
        f.name !== editingName &&
        f.name.toLowerCase() === trimmedName.toLowerCase(),
    );
    if (conflict) {
      setEditError('A field with this name already exists.');
      return;
    }

    const updated: FieldRegistryEntry = { name: trimmedName, type: editType };
    if (editHint.trim()) updated.hint = editHint.trim();

    const next = registry.map((f) => (f.name === editingName ? updated : f));
    setSaveStatus('idle');
    try {
      await update.mutateAsync({ fieldRegistry: next });
      setEditingName(null);
      setSaveStatus('success');
    } catch {
      setSaveStatus('error');
    }
  };

  const performDelete = async () => {
    if (!confirmDeleteName) return;
    setDeleteError(null);
    const next = registry.filter((f) => f.name !== confirmDeleteName);
    setSaveStatus('idle');
    try {
      await update.mutateAsync({ fieldRegistry: next });
      setConfirmDeleteName(null);
      setSaveStatus('success');
    } catch {
      setDeleteError('Failed to delete field. Try again.');
      setSaveStatus('error');
    }
  };

  return (
    <div>
      {/* Empty state */}
      {registry.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed border-line-strong p-8 text-center">
          <p className="text-sm font-medium text-ink-secondary">
            No custom fields
          </p>
          <p className="text-xs text-ink-muted mt-1">
            Add a field to give every entry a consistent set of typed data slots.
          </p>
        </div>
      )}

      {/* Field list */}
      {registry.length > 0 && (
        <ul className="space-y-2 mt-2">
          {registry.map((field) =>
            editingName === field.name ? (
              <li
                key={field.name}
                className="rounded-md border border-line p-3 space-y-2"
              >
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={50}
                    placeholder="e.g. Born in year"
                    className="flex-1 rounded-md border border-line-strong bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void commitEdit();
                      } else if (e.key === 'Escape') {
                        cancelEdit();
                      }
                    }}
                  />
                  <select
                    aria-label="Type"
                    value={editType}
                    onChange={(e) =>
                      setEditType(e.target.value as FieldRegistryEntry['type'])
                    }
                    className="rounded-md border border-line-strong bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                  >
                    <option value="" disabled>
                      Select type...
                    </option>
                    {FIELD_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <input
                  type="text"
                  value={editHint}
                  onChange={(e) => setEditHint(e.target.value)}
                  placeholder="e.g. Use the in-world calendar year"
                  className="w-full rounded-md border border-line-strong bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
                {editError && (
                  <p role="alert" className="text-xs text-red-500">
                    {editError}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void commitEdit()}
                    disabled={update.isPending}
                    className="rounded-md btn-accent text-sm px-3 py-1.5 disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="text-sm text-ink-muted hover:text-ink px-2 py-1"
                  >
                    Cancel
                  </button>
                </div>
              </li>
            ) : (
              <li
                key={field.name}
                className="group flex items-center gap-3 rounded-md border border-line px-3 py-2"
              >
                <span className="flex-1 text-sm font-medium truncate">
                  {field.name}
                </span>
                <span className="text-xs rounded-full border border-line-strong px-2 py-0.5 text-ink-muted">
                  {FIELD_TYPE_OPTIONS.find((o) => o.value === field.type)?.label ??
                    field.type}
                </span>
                {field.hint && (
                  <span className="text-xs text-ink-secondary truncate max-w-[120px]">
                    {field.hint}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => startEdit(field)}
                  aria-label={`Edit ${field.name}`}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-ink-secondary hover:text-ink text-xs ml-1"
                >
                  ✏
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmDeleteName(field.name);
                  }}
                  aria-label={`Delete ${field.name}`}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-ink-secondary hover:text-red-500 text-xs"
                >
                  ✕
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      {/* Add form */}
      <div className="mt-4 flex items-start gap-2 flex-wrap">
        <input
          type="text"
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            setAddError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submitAdd();
            }
          }}
          placeholder="e.g. Born in year"
          maxLength={50}
          className="flex-1 min-w-[160px] rounded-md border border-line-strong bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
          aria-label="Name"
        />
        <select
          aria-label="Type"
          value={newType}
          onChange={(e) => {
            setNewType(e.target.value as FieldRegistryEntry['type'] | '');
            setAddError(null);
          }}
          className="rounded-md border border-line-strong bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
        >
          <option value="" disabled>
            Select type...
          </option>
          {FIELD_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={newHint}
          onChange={(e) => setNewHint(e.target.value)}
          placeholder="e.g. Use the in-world calendar year"
          className="flex-1 min-w-[160px] rounded-md border border-line-strong bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
          aria-label="Hint (optional)"
        />
        <button
          type="button"
          onClick={() => void submitAdd()}
          disabled={update.isPending}
          className="rounded-md btn-accent text-sm px-3 py-1.5 disabled:opacity-50 whitespace-nowrap"
        >
          Add field
        </button>
      </div>

      {addError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          {addError}
        </p>
      )}
      {deleteError && (
        <p role="alert" className="mt-2 text-sm text-red-500">
          {deleteError}
        </p>
      )}

      {/* Save status feedback */}
      {saveStatus === 'success' && (
        <p className="mt-2 text-xs text-green-600 dark:text-green-400">
          Fields saved.
        </p>
      )}
      {saveStatus === 'error' && (
        <p className="mt-2 text-xs text-red-500">
          Couldn&rsquo;t save fields. Try again.
        </p>
      )}

      {/* Delete confirm dialog — D-03 non-destructive copy */}
      <ConfirmDialog
        open={confirmDeleteName !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteName(null);
        }}
        title="Delete this field?"
        body="The field definition is removed from your universe. Existing entry values are not deleted — they become plain meta fields."
        confirmLabel="Delete field"
        destructive
        onConfirm={performDelete}
      />
    </div>
  );
}
