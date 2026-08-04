/**
 * SyncTab — the universe-scoped half of sync (Plan F, Task 3).
 *
 * WHY HERE AND NOT /settings/sync (F-01). `sync_remotes` has no universe
 * column: one saved remote is reused by every universe linked to that peer, so
 * it is managed once per account. `sync_links` and `sync_conflicts` DO carry a
 * universe id, so they belong to the universe they describe. The split mirrors
 * the data model rather than a layout preference — which is also why a user
 * with no remotes is sent to the other surface instead of being offered a form
 * that would create an account-scoped row from inside one universe.
 *
 * F-02 — "SYNC NOW" BLOCKS INLINE. The mutation is awaited and the outcome
 * rendered in place: a result summary, or the mapped error. A `busy` failure
 * offers "Run anyway" (`?force=true`), the recovery path for a claim left stuck
 * by a closed tab, since the server lease is 30 minutes.
 *
 * F-06 — ELAPSED TIME, NEVER SYNTHETIC PROGRESS. A run has no progress signal
 * on the wire, so the only honest thing to show is how long it has been going.
 * A first sync also copies image bytes and can legitimately take minutes, so a
 * link that has never completed one says so — a correct slow run must not look
 * like a hang.
 *
 * HONEST REPORTING.
 *   - `assetsUnrepairable > 0` is stated with its count. The run SUCCEEDED;
 *     this is a warning, not a failure, and hiding the number would leave the
 *     user unable to tell one lost file from two hundred.
 *   - `assetsRepairedLocally` is never shown as a figure. It counts PLANNED
 *     restores and is known to undercount, so a precise number would be one the
 *     user could disprove.
 *   - `thumbSizeBytes` appears nowhere: it is no longer comparable across
 *     instances.
 *
 * ERROR COPY. Every failure here goes through `syncErrorMessage` (a thrown run
 * error) or `lastErrorMessage` (the persisted `sync_links.last_error` column)
 * and out via the shared `SyncErrorNotice`. No error prose is written in this
 * file, and the notice is imported rather than reimplemented — it suppresses
 * the "show details" disclosure when `raw` already contains `detail`, which is
 * exactly the `lastErrorMessage` shape, and a hand-rolled copy would print the
 * same sentence twice.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useSyncLinks,
  useCreateSyncLink,
  useDeleteSyncLink,
  useRunSyncLink,
  type SyncLink,
  type SyncRunResult,
} from '../hooks/useSyncLinks';
import { useSyncRemotes } from '../hooks/useSyncRemotes';
import { syncErrorMessage, lastErrorMessage, type SyncCopy } from '../lib/syncErrorCopy';
import { SyncErrorNotice } from './SyncErrorNotice';
import { SyncRunSummary } from './SyncRunSummary';
import { SyncConflictList } from './SyncConflictList';
import { ConfirmDialog } from './ConfirmDialog';
import { formatRelative } from '../utils/formatRelative';

/**
 * One link's in-flight / just-finished run, as this session saw it.
 *
 * `neverSynced` is captured when the run STARTS rather than read from the live
 * row: the row is refetched the moment the run settles, so reading it live
 * would flip the first-sync warning off mid-run on the very run it describes.
 */
type RunState = {
  pending?: true;
  startedAt?: number;
  neverSynced?: boolean;
  result?: SyncRunResult;
  error?: SyncCopy;
};

/** Seconds since `since`, ticking. The only progress signal a run actually has. */
function ElapsedTime({ since, testId }: { since: number; testId: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span data-testid={testId}>{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
}

/**
 * Attach the persisted `last_error`'s detail to a just-thrown run error.
 *
 * THIS IS WHY THE RUN MUTATION USES `onSettled`. `blob-unavailable`'s `side` —
 * WHICH instance is missing the bytes — is not on the wire; the route
 * serializes only {error, code}. So the thrown copy carries the generic
 * headline plus `raw: "Asset bytes unavailable for 3 content hash(es)"`, a
 * count and not a remedy. The naming of the side exists ONLY in
 * `sync_links.last_error`, which the server writes before the route returns and
 * which `onSettled`'s refetch pulls in. Merging that detail into the thrown
 * copy is what turns the refetch into something the user can actually see;
 * without it the invalidation is real but its payoff is discarded.
 *
 * The merge is gated on the two copies describing the SAME failure.
 * `lastErrorMessage`'s message IS the `SYNC_ERROR_COPY` entry for the code
 * stored in the column, so equal messages mean equal codes — an older, unrelated
 * error still sitting in the column cannot smuggle its detail onto this one.
 * The thrown copy is kept as the base so its `raw` (the count) and its
 * `canForce` survive; `lastErrorMessage` sets neither.
 */
function withPersistedDetail(copy: SyncCopy, lastError: string | null): SyncCopy {
  const persisted = lastErrorMessage(lastError);
  if (!persisted?.detail || persisted.message !== copy.message) return copy;
  return { ...copy, detail: persisted.detail };
}

/** One linked remote: its state, its run controls, and this run's outcome. */
function SyncLinkRow({
  link,
  state,
  onRun,
  onRemove,
}: {
  link: SyncLink;
  state: RunState | undefined;
  onRun: (link: SyncLink, force?: boolean) => void;
  onRemove: (link: SyncLink) => void;
}) {
  // A run this session produced supersedes the column — but only after taking
  // the column's detail with it (see `withPersistedDetail`). The standalone
  // persisted notice is for the untouched case: a link whose last failure
  // happened before this page was opened.
  const runError = state?.error ? withPersistedDetail(state.error, link.lastError) : null;
  const persisted = state ? null : lastErrorMessage(link.lastError);

  return (
    <li
      data-testid={`sync-link-row-${link.id}`}
      className="border-b border-glass-border/60 py-4 last:border-0"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm text-ink">
            {link.remoteLabel || <span className="italic text-ink-muted">(unnamed remote)</span>}
          </p>
          <p className="font-mono text-xs text-ink-muted">{link.remoteBaseUrl}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-ink-secondary">
            {link.lastSyncedAt ? (
              <>
                Last synced{' '}
                <time dateTime={link.lastSyncedAt} title={new Date(link.lastSyncedAt).toLocaleString()}>
                  {formatRelative(link.lastSyncedAt)}
                </time>
              </>
            ) : (
              'Never synced'
            )}
          </span>
          <button
            type="button"
            onClick={() => onRun(link)}
            disabled={!!state?.pending}
            aria-label={`Sync now with ${link.remoteLabel || link.remoteBaseUrl}`}
            className="text-sm text-ink-secondary hover:text-[color:var(--color-accent)] disabled:opacity-50"
          >
            Sync now
          </button>
          <button
            type="button"
            onClick={() => onRemove(link)}
            disabled={!!state?.pending}
            aria-label={`Remove link to ${link.remoteLabel || link.remoteBaseUrl}`}
            className="text-sm text-ink-secondary hover:text-rose-400 disabled:opacity-50"
          >
            Remove link
          </button>
        </div>
      </div>

      {/* F-06: elapsed seconds and nothing that resembles a progress bar. */}
      {state?.pending && (
        <div role="status" className="mt-3 rounded-lg border border-glass-border bg-white/5 p-3 text-sm text-ink-secondary">
          <p>
            Syncing…{' '}
            <ElapsedTime since={state.startedAt ?? Date.now()} testId={`sync-link-elapsed-${link.id}`} />{' '}
            elapsed. Keep this tab open until it finishes.
          </p>
          {state.neverSynced && (
            <p className="mt-1 text-xs opacity-90">
              This is the first sync for this link, so the whole universe is copied across. If it
              holds images, that can take several minutes.
            </p>
          )}
        </div>
      )}

      {state?.result && (
        <SyncRunSummary result={state.result} testId={`sync-link-result-${link.id}`} />
      )}

      {runError && (
        <>
          <SyncErrorNotice copy={runError} testId={`sync-link-run-error-${link.id}`} />
          {/* Only `busy` sets canForce, and only `busy` is fixable by forcing:
              the stuck claim is this link's own, left behind by a run whose tab
              was closed, and the lease it holds is 30 minutes long. */}
          {runError.canForce && (
            <button
              type="button"
              onClick={() => onRun(link, true)}
              className="mt-2 rounded-md border border-glass-border px-3 py-1.5 text-sm text-ink-secondary hover:text-[color:var(--color-accent)]"
            >
              Run anyway
            </button>
          )}
        </>
      )}

      {persisted && (
        <SyncErrorNotice copy={persisted} testId={`sync-link-last-error-${link.id}`} />
      )}
    </li>
  );
}

export function SyncTab({ universeId }: { universeId: string }) {
  const { data: links, isPending, error: listError } = useSyncLinks(universeId);
  const { data: remotes, isPending: remotesPending } = useSyncRemotes();
  const createLink = useCreateSyncLink(universeId);
  const deleteLink = useDeleteSyncLink(universeId);
  const runLink = useRunSyncLink(universeId);

  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [chosenRemote, setChosenRemote] = useState('');
  const [removeTarget, setRemoveTarget] = useState<SyncLink | null>(null);
  const [formError, setFormError] = useState<SyncCopy | null>(null);

  const linked = links ?? [];
  const available = (remotes ?? []).filter((r) => !linked.some((l) => l.remoteId === r.id));

  const handleRun = async (link: SyncLink, force = false) => {
    setRuns((prev) => ({
      ...prev,
      [link.id]: { pending: true, startedAt: Date.now(), neverSynced: link.lastSyncedAt === null },
    }));
    try {
      // F-02: awaited, not fired and forgotten. The user stays on this row and
      // is shown what actually happened.
      const result = await runLink.mutateAsync({ id: link.id, force });
      setRuns((prev) => ({ ...prev, [link.id]: { result } }));
    } catch (err) {
      setRuns((prev) => ({ ...prev, [link.id]: { error: syncErrorMessage(err) } }));
    }
  };

  return (
    <div>
      <h2 className="text-lg font-medium mb-2">Sync</h2>
      <p className="text-sm text-neutral-500 mb-3">
        Link this universe to a remote instance to keep the two copies in step. Remotes themselves
        are saved once per account in{' '}
        <Link to="/settings/sync" className="text-[color:var(--color-accent)] hover:underline">
          Settings → Sync remotes
        </Link>
        .
      </p>

      {isPending && (
        <div className="mt-4 space-y-2" aria-busy="true" aria-label="Loading sync links">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      )}

      {/* The server's own message survives: a server that is down and one that
          refuses the request look identical from here without it. */}
      {!isPending && listError && (
        <SyncErrorNotice copy={syncErrorMessage(listError)} testId="sync-links-list-error" />
      )}

      {!isPending && linked.length === 0 && (
        <p className="mt-4 text-sm text-ink-secondary">
          This universe is not linked to any remote instance yet.
        </p>
      )}

      {/* Gated on the data rather than on `!listError` (same reasoning as
          SyncSettings): TanStack keeps the previous rows while setting `error`
          on a FAILED REFETCH, and a notice above a stale list beats neither. */}
      {linked.length > 0 && (
        <ul className="mt-4" data-testid="sync-links-list">
          {linked.map((link) => (
            <SyncLinkRow
              key={link.id}
              link={link}
              state={runs[link.id]}
              onRun={handleRun}
              onRemove={setRemoveTarget}
            />
          ))}
        </ul>
      )}

      <div className="mt-6 border-t border-glass-border pt-4">
        {/* The pending branch comes FIRST because both branches below make
            positive claims about a list that has not arrived. `remotes` is
            `undefined` mid-fetch, so `remotes.length === 0` is falsy and the
            "already linked" branch would win — telling the user, in a complete
            sentence, something not yet known to be true. */}
        {remotesPending ? (
          <div
            className="h-9 animate-pulse rounded-lg bg-white/5"
            aria-busy="true"
            aria-label="Loading sync remotes"
          />
        ) : remotes && remotes.length === 0 ? (
          <p className="text-sm text-ink-secondary">
            No sync remotes are saved on this account yet. Add the other instance in{' '}
            <Link to="/settings/sync" className="text-[color:var(--color-accent)] hover:underline">
              Settings → Sync remotes
            </Link>
            , then come back here to link this universe to it.
          </p>
        ) : available.length === 0 ? (
          <p className="text-sm text-ink-secondary">
            Every saved remote is already linked to this universe.
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm mb-1" htmlFor="sync-remote-select">
                Remote to link
              </label>
              <select
                id="sync-remote-select"
                value={chosenRemote}
                onChange={(e) => setChosenRemote(e.target.value)}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              >
                <option value="">Choose a remote</option>
                {available.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label || r.baseUrl}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={!chosenRemote || createLink.isPending}
              onClick={async () => {
                setFormError(null);
                try {
                  await createLink.mutateAsync({ remoteId: chosenRemote });
                  setChosenRemote('');
                } catch (err) {
                  setFormError(syncErrorMessage(err));
                }
              }}
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-2 disabled:opacity-50"
            >
              Link universe
            </button>
          </div>
        )}
        {formError && <SyncErrorNotice copy={formError} testId="sync-link-create-error" />}
      </div>

      {/* Task 4 fills this in; the stub renders nothing today. */}
      <SyncConflictList universeId={universeId} />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title="Remove sync link"
        // The stored base snapshot goes with the row, so a re-linked pair has
        // no shared history to merge against and starts from a full bootstrap.
        body={
          removeTarget
            ? `This universe will stop syncing with ${removeTarget.remoteLabel || removeTarget.remoteBaseUrl}. Nothing is deleted on either instance, but linking them again would start from a fresh full sync.`
            : ''
        }
        confirmLabel="Remove link"
        cancelLabel="Cancel"
        destructive
        onConfirm={async () => {
          if (!removeTarget) return;
          const id = removeTarget.id;
          setFormError(null);
          try {
            await deleteLink.mutateAsync({ id });
            // Drop the row's local run state with the row itself.
            setRuns((prev) => {
              if (!(id in prev)) return prev;
              const next = { ...prev };
              delete next[id];
              return next;
            });
          } catch (err) {
            setFormError(syncErrorMessage(err));
          }
          setRemoveTarget(null);
        }}
      />
    </div>
  );
}
