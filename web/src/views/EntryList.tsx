import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useFilterParams } from '../hooks/useFilterParams';
import { useFilteredEntries } from '../hooks/useFilteredEntries';
import { useUniverse } from '../hooks/useUniverse';
import { EntryCard } from '../components/EntryCard';
import { EmptyState } from '../components/EmptyState';
import { ImportDialog } from '../components/ImportDialog';
import { SearchBar } from '../components/SearchBar';
import { FilterChipRow } from '../components/FilterChipRow';
import { ExportMenu } from '../components/ExportMenu';
import { TemplatePicker } from '../components/TemplatePicker';

export function EntryList() {
  const { uid } = useParams<{ uid: string }>();
  const [filters, updateFilters] = useFilterParams();
  const { data: entries, isLoading } = useFilteredEntries(uid!, filters);
  const { data: universe } = useUniverse(uid);

  const [importOpen, setImportOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Auto-dismiss toast after 4 seconds
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const hasActiveFilters =
    !!filters.q || !!filters.type || filters.tags.length > 0 || !!filters.category;

  const isEmpty = !entries || entries.length === 0;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Search + filter UI above the existing toolbar */}
      <div className="mb-4 space-y-3">
        <SearchBar />
        <FilterChipRow universeId={uid!} />
      </div>

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Entries</h1>
        <div className="flex items-center gap-2">
          <ExportMenu
            universeId={uid!}
            fallbackFilename={universe?.name ?? 'universe'}
            onToast={setToast}
          />
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
          >
            Import JSON
          </button>
          {!isEmpty && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5"
            >
              Create entry
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-neutral-500">Loading...</p>
      ) : isEmpty && hasActiveFilters ? (
        <EmptyState
          title="No entries match your filters"
          body="Try removing a filter or clearing the search."
          action={
            <button
              type="button"
              onClick={() =>
                updateFilters({ q: '', type: null, tags: [], category: null })
              }
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-4 py-2"
            >
              Clear filters
            </button>
          }
        />
      ) : isEmpty ? (
        <EmptyState
          title="No entries yet"
          body="Entries are the building blocks of your universe -- people, places, events, and ideas. Create your first entry to start building."
          action={
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-4 py-2"
            >
              Create your first entry
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {entries!.map((entry) => (
            <Link key={entry.id} to={`/universes/${uid}/entries/${entry.id}`}>
              <EntryCard entry={entry} />
            </Link>
          ))}
        </div>
      )}

      {/* Import dialog */}
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />

      {/* Template picker */}
      <TemplatePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        universeId={uid!}
      />

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-600 text-white text-sm px-4 py-2 rounded-md shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}
