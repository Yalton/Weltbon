import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useFilterParams } from '../hooks/useFilterParams';
import { useFilteredEntries } from '../hooks/useFilteredEntries';
import { useUniverse } from '../hooks/useUniverse';
import { useSyncLinks, useRunSyncLink } from '../hooks/useSyncLinks';
import { useSyncConflicts } from '../hooks/useSyncConflicts';
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

  // Feature #42 (task 7) — the first-sync-failed banner. The connect flow
  // deliberately does NOT roll back when a first sync fails: the user keeps
  // the adopted universe and lands right here. An empty universe with no
  // explanation is indistinguishable from data loss, so this banner is what
  // makes that state legible. It is driven by PERSISTED server state (the
  // sync link row), not component/session state, so it survives a reload —
  // a transient toast would not. Skipped in share mode: a visitor has no
  // sync links to explain and no ability to retry one.
  const { data: syncLinks } = useSyncLinks(isShareMode ? undefined : uid);
  const runSyncLink = useRunSyncLink(uid ?? '');
  // Condition is exactly `status === 'error' && lastSyncedAt === null` —
  // errored AND never once synced. Both halves matter: a link that synced
  // fine for weeks and then failed today has a non-null lastSyncedAt and
  // must NOT show this "first sync didn't finish" copy.
  //
  // `.find` deliberately surfaces only the FIRST such link. A universe with
  // links to two different peers could have two links matching this
  // condition at once, and retrying the first (which invalidates and
  // refetches every sync link) would clear the banner even though the
  // second link is still broken. Fine for today — the one-button flow only
  // ever creates one link per universe — but a future multi-peer universe
  // would need this to surface (or cycle through) every match, not just one.
  const failedFirstSyncLink = syncLinks?.find(
    (link) => link.status === 'error' && link.lastSyncedAt === null,
  );

  // #44 (AS-09, task 7) — the unresolved-conflict count. Under MANUAL sync a
  // conflict arrived while the user was watching the screen they had just
  // clicked "Sync now" on; under auto-sync, LWW losers can pile up for days
  // with nobody opening the Sync tab, and a silently discarded edit is the
  // worst outcome this feature can produce. Reuses `useSyncConflicts` (the
  // Sync tab's own query, same cache key) rather than a second query, so this
  // count and the tab's list can never disagree. Skipped in share mode for
  // the same reason as the banner above: a visitor has no sync links.
  const { data: conflicts } = useSyncConflicts(isShareMode ? undefined : uid);
  const conflictCount = conflicts?.length ?? 0;

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
      {/* First-sync-failed banner (Feature #42, task 7). Persisted-state
          driven so it survives a reload — see the hook usage above. */}
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
