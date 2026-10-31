import { useState } from 'react';
import { ApiError } from '../api/client';
import { useAddEntryType, useDeleteEntryType, useRenameEntryType } from '../hooks/useEntryTypes';
import type { Universe } from '../hooks/useUniverse';
import { ConfirmDialog } from './ConfirmDialog';
import { TypeDeleteDialog } from './TypeDeleteDialog';

interface Props {
  universe: Universe;
}

export function EntryTypesSection({ universe }: Props) {
  const addType = useAddEntryType(universe.id);
  const renameType = useRenameEntryType(universe.id);
  const deleteType = useDeleteEntryType(universe.id);

  const [newType, setNewType] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [fallbackTarget, setFallbackTarget] = useState<{ name: string; count: number } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // ----- Add -----
  const submitAdd = async () => {
    const trimmed = newType.trim();
    if (!trimmed) return;
    if (trimmed.length > 50) {
      setAddError('Type name too long (max 50 characters)');
      return;
    }
    setAddError(null);
    try {
      await addType.mutateAsync(trimmed);
      setNewType('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setAddError('Type already exists');
      } else {
        setAddError(err instanceof Error ? err.message : 'Failed to add type');
      }
    }
  };

  // ----- Rename -----
  const startRename = (name: string) => {
    setRenameError(null);
    setRenaming(name);
    setRenameDraft(name);
  };
  const cancelRename = () => {
    setRenaming(null);
    setRenameDraft('');
    setRenameError(null);
  };
  const commitRename = async () => {
    if (!renaming) return;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === renaming) {
      cancelRename();
      return;
    }
    try {
      await renameType.mutateAsync({ oldName: renaming, newName: trimmed });
      cancelRename();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setRenameError('Type already exists');
      } else {
        setRenameError(err instanceof Error ? err.message : 'Failed to rename type');
      }
    }
  };

  // ----- Remove -----
  const requestRemove = (name: string) => {
    setRemoveError(null);
    setConfirmRemove(name);
  };
  const performRemove = async (name: string, fallback?: string) => {
    try {
      await deleteType.mutateAsync({ name, fallback });
      setConfirmRemove(null);
      setFallbackTarget(null);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        typeof err.body === 'object' &&
        err.body !== null &&
        (err.body as { error?: string }).error === 'entries_using_type'
      ) {
        const body = err.body as { count: number; type: string };
        setConfirmRemove(null);
        setFallbackTarget({ name: body.type, count: body.count });
      } else {
        setRemoveError(err instanceof Error ? err.message : 'Failed to delete type');
      }
    }
  };

  const fallbackCandidates = fallbackTarget
    ? universe.entryTypes.filter((t) => t !== fallbackTarget.name)
    : [];

  return (
    <div>
      <ul className="flex flex-wrap gap-2">
        {universe.entryTypes.map((type) => {
          const isRenaming = renaming === type;
          return (
            <li
              key={type}
              className="inline-flex items-center gap-1 rounded-full border border-line-strong px-3 py-1 text-sm"
            >
              {isRenaming ? (
                <input
                  autoFocus
                  type="text"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  className="bg-transparent outline-none text-sm w-24"
                />
              ) : (
                <>
                  <span>{type}</span>
                  <button
                    type="button"
                    aria-label={`Rename ${type}`}
                    onClick={() => startRename(type)}
                    className="ml-1 text-xs text-ink-secondary hover:text-ink"
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${type}`}
                    onClick={() => requestRemove(type)}
                    className="text-xs text-ink-secondary hover:text-red-600"
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {renameError && (
        <p role="alert" className="mt-2 text-sm text-red-500">{renameError}</p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <input
          type="text"
          value={newType}
          onChange={(e) => { setNewType(e.target.value); setAddError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submitAdd();
            }
          }}
          placeholder="Add type"
          maxLength={50}
          className="rounded-md border border-line-strong bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
        />
        <button
          type="button"
          onClick={() => void submitAdd()}
          disabled={!newType.trim() || addType.isPending}
          className="rounded-md btn-accent text-sm px-3 py-1.5 disabled:opacity-50"
        >
          +
        </button>
      </div>
      {addError && (
        <p role="alert" className="mt-2 text-sm text-red-500">{addError}</p>
      )}
      {removeError && (
        <p role="alert" className="mt-2 text-sm text-red-500">{removeError}</p>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}
        title={confirmRemove ? `Delete "${confirmRemove}"?` : ''}
        body="Entries using this type will need to be reassigned if any exist."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (confirmRemove) await performRemove(confirmRemove);
        }}
      />

      <TypeDeleteDialog
        open={fallbackTarget !== null}
        onOpenChange={(open) => { if (!open) setFallbackTarget(null); }}
        typeName={fallbackTarget?.name ?? ''}
        count={fallbackTarget?.count ?? 0}
        candidates={fallbackCandidates}
        onConfirm={async (fallback) => {
          if (fallbackTarget) await performRemove(fallbackTarget.name, fallback);
        }}
      />
    </div>
  );
}
