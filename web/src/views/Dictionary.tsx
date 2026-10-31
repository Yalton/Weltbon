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


type ToastState = { message: string; variant: 'success' | 'error' } | null;


export function Dictionary() {
  const { uid, lid: lidParam } = useParams<{ uid: string; lid?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [q, setQ] = useState(searchParams.get('q') ?? '');
  const lid = lidParam ?? null; // route-driven language scope

  // Client-side facets (applied inside DictionaryTable)
  const [posFilter, setPosFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

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

  useEffect(() => {
    const urlQ = searchParams.get('q') ?? '';
    if (urlQ !== q) setQ(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const urlQ = searchParams.get('q') ?? '';
  const filters: DictionaryFilters = { q: urlQ, lid };

  const { data, isPending, error } = useFilteredDictionary(uid!, filters);
  const { data: langEntries } = useLanguageEntries(uid!);
  const createWord = useCreateWord(uid!);

  const hasActiveFilters = !!urlQ || !!lid || !!posFilter || !!tagFilter;

  const posOptions = Array.from(
    new Set((data ?? []).map((w) => w.partOfSpeech).filter(Boolean)),
  ).sort();

  const tagOptions = Array.from(
    new Set((data ?? []).flatMap((w) => w.tags)),
  ).sort();

  function handleLangSwitch(newLid: string | null) {
    if (newLid) {
      navigate(`/universes/${uid}/languages/${newLid}/dictionary`);
    } else {
      navigate(`/universes/${uid}/dictionary`);
    }
  }

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

  function handleImported(result: { inserted: number; updated: number }) {
    const n = result.inserted + result.updated;
    setToast({ message: `Imported ${n} word(s)`, variant: 'success' });
  }

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
              className="text-xs font-semibold uppercase tracking-wide text-ink-muted"
            >
              Dictionary
            </label>
            <select
              id="lang-switcher"
              value={lid ?? ''}
              onChange={(e) => handleLangSwitch(e.target.value || null)}
              className="rounded-md border border-line-strong bg-panel px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
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
            className="flex-1 min-w-[200px] rounded-md border border-line-strong bg-panel px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
          />

          {/* CTA buttons */}
          <button
            type="button"
            onClick={handleAddWord}
            className="px-3 py-2 text-sm rounded-md btn-accent hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
          >
            Add word
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="px-3 py-2 text-sm rounded-md border border-line-strong hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
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
                className="text-xs font-semibold uppercase tracking-wide text-ink-muted"
              >
                POS
              </label>
              <select
                id="pos-filter"
                value={posFilter}
                onChange={(e) => setPosFilter(e.target.value)}
                className="rounded-md border border-line-strong bg-panel px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
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
                className="text-xs font-semibold uppercase tracking-wide text-ink-muted"
              >
                Tag
              </label>
              <select
                id="tag-filter"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                className="rounded-md border border-line-strong bg-panel px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
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
                <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-1 text-xs">
                  Search: {urlQ}
                  <button
                    type="button"
                    onClick={() => handleSearchChange('')}
                    aria-label="Clear search filter"
                    className="text-ink-muted hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              )}
              {posFilter && (
                <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-1 text-xs">
                  POS: {posFilter}
                  <button
                    type="button"
                    onClick={() => setPosFilter('')}
                    aria-label="Clear POS filter"
                    className="text-ink-muted hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              )}
              {tagFilter && (
                <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-1 text-xs">
                  Tag: {tagFilter}
                  <button
                    type="button"
                    onClick={() => setTagFilter('')}
                    aria-label="Clear tag filter"
                    className="text-ink-muted hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={clearAllFilters}
                className="text-xs text-ink-muted hover:text-ink"
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
