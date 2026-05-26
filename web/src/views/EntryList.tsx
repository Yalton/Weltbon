import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
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
import { Toast } from '../components/Toast';
import { AuditCostDialog } from '../components/AuditCostDialog';

type ToastState = { message: string; variant: 'success' | 'error' } | null;

export function EntryList() {
  const { uid } = useParams<{ uid: string }>();
  const location = useLocation();
  const [filters, updateFilters] = useFilterParams();
  const { data: entries, isLoading } = useFilteredEntries(uid!, filters);
  const { data: universe } = useUniverse(uid);

  const [importOpen, setImportOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [auditDialogOpen, setAuditDialogOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  // Toast auto-dismiss is now handled inside <Toast />.

  // One-shot bridge: if we landed here with location.state.toast set (e.g.,
  // from the Phase 12 IngestImport post-commit navigation per UI-SPEC §6.7),
  // surface it via the existing <Toast> with the supplied variant.
  useEffect(() => {
    const stateToast = location.state as
      | { toast?: string; toastVariant?: 'success' | 'error' }
      | null;
    if (stateToast?.toast) {
      setToast({
        message: stateToast.toast,
        variant: stateToast.toastVariant ?? 'success',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            onToast={(message) => setToast({ message, variant: 'error' })}
          />
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
          >
            Import JSON
          </button>
          <Link
            to={`/universes/${uid}/import`}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
          >
            Import notes
          </Link>
          {universe?.auditEnabled === true && (
            <button
              type="button"
              onClick={() => setAuditDialogOpen(true)}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 inline-flex items-center gap-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800"
              aria-haspopup="dialog"
            >
              ⚖ Audit gaps
            </button>
          )}
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
          title="Nothing matches these filters"
          body="Try removing a filter or clearing the search."
          action={
            <button
              type="button"
              onClick={() =>
                updateFilters({ q: '', type: null, tags: [], category: null })
              }
              className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              Clear filters
            </button>
          }
        />
      ) : isEmpty ? (
        <EmptyState
          title="Start with one idea"
          body="Entries are the building blocks of your universe — people, places, events, ideas. Pick a template or start from scratch."
          action={
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              New entry
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

      {/* Audit cost / progress dialog — opened by ⚖ Audit gaps button.
          Mount only when the audit feature is enabled on this universe so the
          dialog's useEstimateAudit query never fires for opted-out universes. */}
      {universe?.auditEnabled === true && (
        <AuditCostDialog
          open={auditDialogOpen}
          onOpenChange={setAuditDialogOpen}
          universeId={uid!}
          scope="universe"
          onStarted={() => setToast({ message: 'Audit started.', variant: 'success' })}
        />
      )}

      {/* Toast notification */}
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
