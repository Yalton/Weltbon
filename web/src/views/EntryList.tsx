import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useFilterParams } from '../hooks/useFilterParams';
import { useFilteredEntries } from '../hooks/useFilteredEntries';
import { useUniverse } from '../hooks/useUniverse';
import { useSyncLinks, useRunSyncLink } from '../hooks/useSyncLinks';
import { useSyncConflictCount } from '../hooks/useSyncConflicts';
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
import { Glyph } from '../components/CategoryIcon';

type ToastState = { message: string; variant: 'success' | 'error' } | null;

export function EntryList() {
  // into the path. The api-client seam (web/src/api/client.ts) strips the
  const { uid: paramUid, token } = useParams<{ uid: string; token: string }>();
  const isShareMode = useShareMode();
  const uid = paramUid ?? (isShareMode ? 'share' : undefined);
  const location = useLocation();
  const [filters, updateFilters] = useFilterParams();
  const { data: entries, isLoading } = useFilteredEntries(uid!, filters);
  const { data: universe } = useUniverse(uid);

  const { data: syncLinks } = useSyncLinks(isShareMode ? undefined : uid);
  const runSyncLink = useRunSyncLink(uid ?? '');
  // fine for weeks and then failed today has a non-null lastSyncedAt and
  // second link is still broken. Fine for today — the one-button flow only
  // ever creates one link per universe — but a future multi-peer universe
  const failedFirstSyncLink = syncLinks?.find(
    (link) => link.status === 'error' && link.lastSyncedAt === null,
  );

  // clicked "Sync now" on; under auto-sync, LWW losers can pile up for days
  // serving the previous successful `data`. Re-deriving `.length` locally
  const conflictCount = useSyncConflictCount(isShareMode ? undefined : uid);

  const [importOpen, setImportOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [auditDialogOpen, setAuditDialogOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  // Toast auto-dismiss is now handled inside <Toast />.

  // One-shot bridge: if we landed here with location.state.toast set (e.g.,
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

      {failedFirstSyncLink && (
        <div
          role="alert"
          data-testid="first-sync-failed-banner"
          className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300"
        >
          <p>
            The first sync didn't finish, so this universe may look empty right
            now. Nothing has been lost — try again to bring your content in.
          </p>
          <button
            type="button"
            onClick={() => runSyncLink.mutate({ id: failedFirstSyncLink.id })}
            disabled={runSyncLink.isPending}
            className="mt-2 rounded-md border border-rose-400/50 px-3 py-1.5 text-sm font-medium hover:bg-rose-500/10 disabled:opacity-50"
          >
            Try again
          </button>
        </div>
      )}

      {/* Unresolved sync conflicts (#44, AS-09). Count only, plus a link into
          the Sync tab — resolving/restoring a conflict is that tab's job, not
          this one's. */}
      {conflictCount > 0 && (
        <div
          role="status"
          data-testid="sync-conflicts-banner"
          className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
        >
          <p>
            {conflictCount} unresolved sync {conflictCount === 1 ? 'conflict' : 'conflicts'} on
            this universe — an edit made here and on a synced instance at close to the same time,
            where one side's version was kept and the other's saved for review.
          </p>
          <Link
            to={`/universes/${uid}/settings?tab=sync`}
            className="mt-2 inline-block rounded-md border border-amber-400/50 px-3 py-1.5 text-sm font-medium hover:bg-amber-500/10"
          >
            Review in Sync
          </Link>
        </div>
      )}

      {/* Search + filter UI above the existing toolbar */}
      <div className="mb-4 space-y-3">
        <SearchBar />
        <FilterChipRow universeId={uid!} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Entries</h1>
        <div className="flex flex-wrap items-center gap-2">

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
                  <Glyph name="scale" />
                  Audit gaps
                </button>
              )}
              {!isEmpty && (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="rounded-md btn-accent text-white text-sm px-3 py-1.5"
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
              className="btn-accent text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              Clear filters
            </button>
          }
        />
      ) : isEmpty ? (
        <EmptyState
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
            // empty state. The empty-state copy is still useful context
            !isShareMode ? (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="btn-accent text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
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

      {/* Audit cost / progress dialog — opened by the Audit gaps button.
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
