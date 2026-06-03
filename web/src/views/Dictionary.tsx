import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import {
  useFilteredDictionary,
  useCreateWord,
  useLanguageEntries,
  type DictionaryFilters,
  type DictionaryWord,
  type CreateWordInput,
} from '../hooks/useDictionary';
import { DictionaryTable } from '../components/DictionaryTable';
import { DictionaryImportDialog } from '../components/DictionaryImportDialog';
import { Toast } from '../components/Toast';

// ─── Types ───────────────────────────────────────────────────────────────────

type ToastState = { message: string; variant: 'success' | 'error' } | null;

// ─── Dictionary View ─────────────────────────────────────────────────────────

/**
 * Phase 32 Plan 03 — Dictionary page view.
 *
 * Mounts at:
 *   /universes/:uid/dictionary          (universe-level dictionary)
 *   /universes/:uid/languages/:lid/dictionary  (language-scoped dictionary)
 *
 * Toolbar: language switcher + FTS search box (300ms debounce → ?q=) +
 * "Add word" primary + "Import CSV" secondary + POS/tag facet chips.
 *
 * Server refetch: ?q= (FTS) and ?lid= (language scope) — both change the
 * React Query key. Client-side sort + facets live in DictionaryTable.
 */
export function Dictionary() {
  const { uid, lid: lidParam } = useParams<{ uid: string; lid?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Filter state ────────────────────────────────────────────────────────
  // q from URL ?q=; lid from route param or URL ?lid=
  const [q, setQ] = useState(searchParams.get('q') ?? '');
  const lid = lidParam ?? null; // route-driven language scope

  // Client-side facets (applied inside DictionaryTable)
  const [posFilter, setPosFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  // Active word being added (blank editable row at bottom)
  const [addingNew, setAddingNew] = useState(false);
  // Active row being edited (inline)
  const [editingId, setEditingId] = useState<string | null>(null);
  // Import dialog
  const [importOpen, setImportOpen] = useState(false);
  // Toast
  const [toast, setToast] = useState<ToastState>(null);

  // ── Debounced q → URL sync ──────────────────────────────────────────────
  const syncQ = useDebouncedCallback((value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set('q', value);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, 300);

  const handleSearchChange = useCallback(
    (value: string) => {
      setQ(value);
      syncQ(value);
    },
    [syncQ],
  );

  // Resync q from URL when navigating back/forward
  useEffect(() => {
    const urlQ = searchParams.get('q') ?? '';
    if (urlQ !== q) setQ(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── Data ────────────────────────────────────────────────────────────────
  const urlQ = searchParams.get('q') ?? '';
  const filters: DictionaryFilters = { q: urlQ, lid };

  const { data, isPending, error } = useFilteredDictionary(uid!, filters);
  const { data: langEntries } = useLanguageEntries(uid!);
  const createWord = useCreateWord(uid!);

  // ── Derived state ────────────────────────────────────────────────────────
  const hasActiveFilters = !!urlQ || !!lid || !!posFilter || !!tagFilter;

  // Distinct POS values from the current result set for the POS filter
  const posOptions = Array.from(
    new Set((data ?? []).map((w) => w.partOfSpeech).filter(Boolean)),
  ).sort();

  // Distinct tags from the current result set for the tag filter
  const tagOptions = Array.from(
    new Set((data ?? []).flatMap((w) => w.tags)),
  ).sort();

  // ── Language switcher ────────────────────────────────────────────────────
  function handleLangSwitch(newLid: string | null) {
    if (newLid) {
      navigate(`/universes/${uid}/languages/${newLid}/dictionary`);
    } else {
      navigate(`/universes/${uid}/dictionary`);
    }
  }

  // ── Add word (inline row at bottom) ─────────────────────────────────────
  function handleAddWord() {
    setEditingId(null);
    setAddingNew(true);
  }

  async function handleSaveNew(draft: CreateWordInput) {
    try {
      await createWord.mutateAsync({ ...draft, languageEntryId: lid });
      setAddingNew(false);
      setToast({ message: 'Word added', variant: 'success' });
    } catch {
      setToast({ message: 'Could not save word. Try again.', variant: 'error' });
    }
  }

  function handleDiscardNew() {
    setAddingNew(false);
  }

  // ── Import ───────────────────────────────────────────────────────────────
  function handleImported(result: { inserted: number; updated: number }) {
    const n = result.inserted + result.updated;
    setToast({ message: `Imported ${n} word(s)`, variant: 'success' });
  }

  // ── Clear facets ─────────────────────────────────────────────────────────
  function clearAllFilters() {
    setQ('');
    setPosFilter('');
    setTagFilter('');
    setSearchParams({}, { replace: true });
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Dictionary</h1>
      </div>

      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="space-y-3 mb-6">
        {/* Row 1: language switcher + search */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Language switcher */}
          <div className="flex items-center gap-1.5">
            <label
              htmlFor="lang-switcher"
              className="text-xs font-semibold uppercase tracking-wide text-neutral-500"
            >
              Dictionary
            </label>
            <select
              id="lang-switcher"
              value={lid ?? ''}
              onChange={(e) => handleLangSwitch(e.target.value || null)}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
            >
              <option value="">Universe dictionary</option>
              {(langEntries ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </div>

          {/* FTS search box */}
          <input
            type="search"
            value={q}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search words..."
            aria-label="Search dictionary words"
            className="flex-1 min-w-[200px] rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
          />

          {/* CTA buttons */}
          <button
            type="button"
            onClick={handleAddWord}
            className="px-3 py-2 text-sm rounded-md bg-[color:var(--color-accent)] text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
          >
            Add word
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="px-3 py-2 text-sm rounded-md border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
          >
            Import CSV
          </button>
        </div>

        {/* Row 2: POS + tag facet selects */}
        <div className="flex items-center gap-3 flex-wrap">
          {posOptions.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="pos-filter"
                className="text-xs font-semibold uppercase tracking-wide text-neutral-500"
              >
                POS
              </label>
              <select
                id="pos-filter"
                value={posFilter}
                onChange={(e) => setPosFilter(e.target.value)}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              >
                <option value="">All</option>
                {posOptions.map((pos) => (
                  <option key={pos} value={pos}>
                    {pos}
                  </option>
                ))}
              </select>
            </div>
          )}

          {tagOptions.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="tag-filter"
                className="text-xs font-semibold uppercase tracking-wide text-neutral-500"
              >
                Tag
              </label>
              <select
                id="tag-filter"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
              >
                <option value="">All</option>
                {tagOptions.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Active filter chips */}
          {hasActiveFilters && (
            <div className="flex items-center gap-2 flex-wrap">
              {urlQ && (
                <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-1 text-xs">
                  Search: {urlQ}
                  <button
                    type="button"
                    onClick={() => handleSearchChange('')}
                    aria-label="Clear search filter"
                    className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                  >
                    ×
                  </button>
                </span>
              )}
              {posFilter && (
                <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-1 text-xs">
                  POS: {posFilter}
                  <button
                    type="button"
                    onClick={() => setPosFilter('')}
                    aria-label="Clear POS filter"
                    className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                  >
                    ×
                  </button>
                </span>
              )}
              {tagFilter && (
                <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-1 text-xs">
                  Tag: {tagFilter}
                  <button
                    type="button"
                    onClick={() => setTagFilter('')}
                    aria-label="Clear tag filter"
                    className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                  >
                    ×
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────────── */}
      <DictionaryTable
        universeId={uid!}
        data={data}
        isPending={isPending}
        error={error as Error | null}
        posFilter={posFilter}
        tagFilter={tagFilter}
        editingId={editingId}
        addingNew={addingNew}
        lid={lid}
        onEdit={(id) => {
          setAddingNew(false);
          setEditingId(id);
        }}
        onEditDone={() => setEditingId(null)}
        onAddWord={handleAddWord}
        onSaveNew={handleSaveNew}
        onDiscardNew={handleDiscardNew}
        onToast={setToast}
      />

      {/* ── Import dialog ───────────────────────────────────────────────── */}
      <DictionaryImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        universeId={uid!}
        lid={lid}
        onImported={handleImported}
      />

      {/* ── Toast ───────────────────────────────────────────────────────── */}
      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
