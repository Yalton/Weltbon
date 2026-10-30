import { useMemo, useState } from 'react';
import {
  useUpdateWord,
  useDeleteWord,
  type DictionaryWord,
  type CreateWordInput,
} from '../hooks/useDictionary';
import { DictionaryRowEditor } from './DictionaryRowEditor';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { DICTIONARY_TERMS } from './dictionaryTerms';

// Dotted-underline cue signalling a hover definition is available on a term.
const TERM_HINT =
  'cursor-help underline decoration-dotted decoration-[color:var(--color-ink-muted)] underline-offset-2';


type SortKey = 'word' | 'partOfSpeech';
type SortDir = 'asc' | 'desc';

type ToastState = { message: string; variant: 'success' | 'error' } | null;

export interface DictionaryTableProps {
  universeId: string;
  data: DictionaryWord[] | undefined;
  isPending: boolean;
  error: Error | null;
  posFilter: string;
  tagFilter: string;
  editingId: string | null;
  addingNew: boolean;
  lid: string | null;
  onEdit: (id: string) => void;
  onEditDone: () => void;
  onAddWord: () => void;
  onSaveNew: (draft: CreateWordInput) => void | Promise<void>;
  onDiscardNew: () => void;
  onToast: (toast: ToastState) => void;
}


export function DictionaryTable({
  universeId,
  data,
  isPending,
  error,
  posFilter,
  tagFilter,
  editingId,
  addingNew,
  lid,
  onEdit,
  onEditDone,
  onSaveNew,
  onDiscardNew,
  onToast,
}: DictionaryTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('word');
  const [sortDir, setSortDir] = useState<SortDir>('asc'); // D-12: default word asc

  const [deletingWord, setDeletingWord] = useState<DictionaryWord | null>(null);

  const [savingId, setSavingId] = useState<string | null>(null);

  const updateWord = useUpdateWord(universeId, editingId ?? '');
  const deleteWord = useDeleteWord(universeId, deletingWord?.id ?? '');

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('asc'); // reset to asc when switching columns
    }
  }

  function sortArrow(key: SortKey): string {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? '↑' : '↓';
  }

  function sortAriaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    if (sortKey !== key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  // ── Sorted + filtered rows (D-13: client-side facets over server result) ──
  const sortedRows = useMemo<DictionaryWord[]>(() => {
    if (!data) return [];
    let rows = [...data];

    // Client-side facet filters (POS + tag)
    if (posFilter) rows = rows.filter((r) => r.partOfSpeech === posFilter);
    if (tagFilter) rows = rows.filter((r) => r.tags.includes(tagFilter));

    rows.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'word') {
        cmp = a.word.localeCompare(b.word);
      } else if (sortKey === 'partOfSpeech') {
        cmp = a.partOfSpeech.localeCompare(b.partOfSpeech);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return rows;
  }, [data, sortKey, sortDir, posFilter, tagFilter]);

  async function handleSaveEdit(draft: CreateWordInput) {
    if (!editingId) return;
    setSavingId(editingId);
    try {
      await updateWord.mutateAsync(draft);
      onEditDone();
      onToast({ message: 'Word saved', variant: 'success' });
    } catch {
      onToast({ message: 'Could not save word. Try again.', variant: 'error' });
    } finally {
      setSavingId(null);
    }
  }

  async function handleDeleteConfirm() {
    if (!deletingWord) return;
    try {
      await deleteWord.mutateAsync();
      onToast({ message: `"${deletingWord.word}" deleted`, variant: 'success' });
    } catch {
      onToast({
        message: 'Could not delete word. Try again.',
        variant: 'error',
      });
    } finally {
      setDeletingWord(null);
    }
  }

  if (isPending) {
    return (
      <div
        className="mt-6 space-y-2"
        aria-busy="true"
        aria-label="Loading dictionary"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-12 rounded-md bg-raised animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="mt-6 rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300"
      >
        Could not load dictionary. Refresh the page to try again.
      </div>
    );
  }

  const hasFilters = !!posFilter || !!tagFilter;
  if ((!data || data.length === 0) && !addingNew) {
    return (
      <EmptyState
        title="No words yet"
        body="Add your first word or import a CSV to start building your dictionary."
      />
    );
  }

  if (sortedRows.length === 0 && hasFilters && !addingNew) {
    return (
      <EmptyState
        title="No words match"
        body="Try a different search or clear the filters."
      />
    );
  }

  return (
    <>
      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Dictionary words for this language</caption>
          <thead>
            <tr className="border-b border-line">
              {/* Word — sortable (UI-SPEC: accent when active) */}
              <th
                scope="col"
                className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted"
                aria-sort={sortAriaSort('word')}
              >
                <button
                  type="button"
                  onClick={() => toggleSort('word')}
                  className={`inline-flex items-center gap-1 cursor-pointer ${
                    sortKey === 'word'
                      ? 'text-[color:var(--color-accent)]'
                      : ''
                  }`}
                >
                  Word {sortArrow('word')}
                </button>
              </th>

              {/* IPA — not sortable */}
              <th
                scope="col"
                className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted"
              >
                <span className={TERM_HINT} title={DICTIONARY_TERMS.ipa}>
                  IPA
                </span>
              </th>

              {/* POS — sortable */}
              <th
                scope="col"
                className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted"
                aria-sort={sortAriaSort('partOfSpeech')}
              >
                <button
                  type="button"
                  onClick={() => toggleSort('partOfSpeech')}
                  className={`inline-flex items-center gap-1 cursor-pointer ${
                    sortKey === 'partOfSpeech'
                      ? 'text-[color:var(--color-accent)]'
                      : ''
                  }`}
                >
                  <span className={TERM_HINT} title={DICTIONARY_TERMS.partOfSpeech}>
                    POS
                  </span>{' '}
                  {sortArrow('partOfSpeech')}
                </button>
              </th>

              {/* Gloss */}
              <th
                scope="col"
                className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted"
              >
                <span className={TERM_HINT} title={DICTIONARY_TERMS.gloss}>
                  Gloss
                </span>
              </th>

              {/* Etymology */}
              <th
                scope="col"
                className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted"
              >
                <span className={TERM_HINT} title={DICTIONARY_TERMS.etymology}>
                  Etymology
                </span>
              </th>

              {/* Tags */}
              <th
                scope="col"
                className="pb-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted"
              >
                <span className={TERM_HINT} title={DICTIONARY_TERMS.tags}>
                  Tags
                </span>
              </th>

              {/* Actions — no label, sr-only */}
              <th scope="col" className="pb-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => {
              if (editingId === row.id) {
                return (
                  <DictionaryRowEditor
                    key={row.id}
                    word={row}
                    isSaving={savingId === row.id}
                    languageEntryId={lid}
                    onSave={handleSaveEdit}
                    onDiscard={onEditDone}
                  />
                );
              }

              return (
                <tr
                  key={row.id}
                  className="border-b border-line last:border-0 hover:bg-white/5 group"
                >
                  {/* Word */}
                  <td className="py-3 pr-4 text-sm leading-[1.5] font-semibold">
                    {row.word}
                  </td>

                  {/* IPA */}
                  <td className="py-3 pr-4 text-sm leading-[1.5] font-mono text-ink-muted">
                    {row.ipa || '—'}
                  </td>

                  {/* POS */}
                  <td className="py-3 pr-4 text-sm leading-[1.5] text-ink-secondary">
                    {row.partOfSpeech || '—'}
                  </td>

                  {/* Gloss */}
                  <td className="py-3 pr-4 text-sm leading-[1.5]">
                    {row.gloss}
                  </td>

                  {/* Etymology — truncated in read view */}
                  <td className="py-3 pr-4 text-sm leading-[1.5] max-w-[200px]">
                    {row.etymology ? (
                      <span
                        className="line-clamp-2 text-ink-secondary"
                        title={row.etymology}
                      >
                        {row.etymology}
                      </span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>

                  {/* Tags */}
                  <td className="py-3 pr-4 text-sm leading-[1.5]">
                    {row.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {row.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center rounded-full bg-raised px-2 py-0.5 text-xs"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>

                  {/* Actions — visible on hover (group-hover) */}
                  <td className="py-3 text-right">
                    <div className="inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => onEdit(row.id)}
                        aria-label={`Edit ${row.word}`}
                        className="rounded p-1 text-ink-muted hover:text-ink hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingWord(row)}
                        aria-label={`Delete ${row.word}`}
                        className="rounded p-1 text-ink-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}

            {/* Add-new row: blank editable row at bottom */}
            {addingNew && (
              <DictionaryRowEditor
                key="__add_new__"
                word={null}
                isSaving={false}
                languageEntryId={lid}
                onSave={onSaveNew}
                onDiscard={onDiscardNew}
              />
            )}
          </tbody>
        </table>
      </div>

      {/* ── Delete confirm dialog ─────────────────────────────────────────── */}
      <ConfirmDialog
        open={!!deletingWord}
        onOpenChange={(open) => {
          if (!open) setDeletingWord(null);
        }}
        title="Delete word?"
        body={
          deletingWord
            ? `This will permanently remove "${deletingWord.word}" from the dictionary. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete word"
        destructive={true}
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}
