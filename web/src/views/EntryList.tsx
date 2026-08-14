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
import { useShareMode } from '../contexts/ShareModeContext';
import { Loading } from '../components/ui/Loading';

type ToastState = { message: string; variant: 'success' | 'error' } | null;

export function EntryList() {
  // Phase 29 — share-mode awareness. In share mode there is no `uid` URL
  // param (the visitor URL is `/share/:token`), so we substitute the
  // literal 'share' string for hooks that interpolate the universe id
  // into the path. The api-client seam (web/src/api/client.ts) strips the
  // `/universes/<anything>` prefix when shareTokenPlaintext is set, so the
  // resulting fetch is /api/share/entries — exactly what the Plan 04 read
  // namespace serves.
  const { uid: paramUid, token } = useParams<{ uid: string; token: string }>();
  const isShareMode = useShareMode();
  const uid = paramUid ?? (isShareMode ? 'share' : undefined);
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
    !!filters.q ||
    !!filters.type ||
    filters.tags.length > 0 ||
    !!filters.category ||
    filters.wip !== null ||
    Object.keys(filters.fieldFilters).length > 0;

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
          {/*
            Phase 29 D-18 — in share mode every create / import affordance
            is hidden. ExportMenu is also hidden because the share read
            namespace (Plan 04) does not expose export endpoints; surfacing
            a non-functional button would mislead the visitor. Audit gaps
            is owner-only by both design and backend gating.
          */}
          {!isShareMode && (
            <>
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
            </>
          )}
        </div>
      </div>

      {isLoading ? (
        <Loading />
      ) : isEmpty && hasActiveFilters ? (
        <EmptyState
          title="Nothing matches these filters"
          body="Try removing a filter or clearing the search."
          action={
            <button
              type="button"
              onClick={() =>
                updateFilters({
                  q: '',
                  type: null,
                  tags: [],
                  category: null,
                  wip: null,
                  fieldFilters: {},
                })
              }
              className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              Clear filters
            </button>
          }
        />
      ) : isEmpty ? (
        <EmptyState
          // Phase 29 Gap 3 — gate empty-state copy on isShareMode so the
          // visitor surface uses jargon-free, visitor-appropriate strings
          // instead of owner-onboarding copy that leaks "universe" terminology
          // and prompts actions unavailable to a read-only visitor.
          title={isShareMode ? 'Nothing shared yet' : 'Start with one idea'}
          body={
            isShareMode
              ? "The owner hasn't shared any entries here yet."
              : 'Entries are the building blocks of your universe — people, places, events, ideas. Pick a template or start from scratch.'
          }
          action={
            // Phase 29 D-18 — share-mode visitors get no create CTA on the
            // empty state. The empty-state copy is still useful context
            // ("no public entries yet"), so we render the heading/body
            // without an action.
            !isShareMode ? (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                New entry
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-2">
          {entries!.map((entry) => (
            <Link
              key={entry.id}
              to={
                isShareMode
                  ? `/share/${token ?? ''}/entries/${entry.id}`
                  : `/universes/${uid}/entries/${entry.id}`
              }
            >
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
