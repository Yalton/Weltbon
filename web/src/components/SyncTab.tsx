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
import {
  syncErrorMessage,
  lastErrorMessage,
  combineRunError,
  type SyncCopy,
} from '../lib/syncErrorCopy';
import { SyncErrorNotice } from './SyncErrorNotice';
import { SyncRunSummary } from './SyncRunSummary';
import { SyncConflictList } from './SyncConflictList';
import { ConfirmDialog } from './ConfirmDialog';
import { formatRelative } from '../utils/formatRelative';

/**
 * One link's in-flight / just-finished run, as this session saw it.
 *
 * A discriminated union rather than a bag of optionals, so the impossible
 * states cannot be written. `{pending: true}` without `startedAt` used to
 * typecheck, and the `startedAt ?? Date.now()` fallback it forced would have
 * handed `ElapsedTime` a FRESH value on every render — resetting the clock
 * each tick, so the counter could never leave `0s`. Making `startedAt`
 * mandatory on the running variant removes both the bug and the fallback.
 *
 * `neverSynced` is captured when the run STARTS rather than read from the live
 * row: links share one query key, so another link's run settling refetches this
 * row mid-run, and a server that has already recorded this run would flip the
 * first-sync warning off underneath the user still waiting for it.
 */
type RunState =
  | { phase: 'running'; startedAt: number; neverSynced: boolean }
  | { phase: 'done'; result: SyncRunResult }
  | { phase: 'failed'; error: SyncCopy };

/** Seconds since `since`, ticking. The only progress signal a run actually has. */
function ElapsedTime({ since, testId }: { since: number; testId: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  // aria-hidden: this span lives inside a role="status" region, which implies
  // aria-live="polite" AND aria-atomic="true". Mutating text inside it once a
  // second makes a screen reader re-announce the WHOLE block — "Syncing, 1s
  // elapsed, keep this tab open…", plus the first-sync paragraph — every second,
  // for a run this component's own copy says may take minutes. Hidden here, the
  // region announces one stable sentence and the visual display is untouched.
  return (
    <span data-testid={testId} aria-hidden="true">
      {Math.max(0, Math.floor((now - since) / 1000))}s
    </span>
  );
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
  // A run this session FAILED gets `combineRunError`, which either folds the
  // refetched column into the thrown copy (same code) or hands it back to be
  // shown alongside (different code, or no code — the generic "Failed to fetch"
  // case, which is the likeliest failure of a multi-minute request and the one
  // where the column holds the only real diagnosis).
  //
  // Suppressing the column outright whenever ANY run state existed was the
  // original bug here: the `onSettled` refetch fired, the cache updated, and
  // the user was shown "Something went wrong while talking to the server" while
  // the answer sat unread one field away.
  const combined = state?.phase === 'failed' ? combineRunError(state.error, link.lastError) : null;
  const runError = combined?.copy ?? null;
  // On a run that has not failed (in flight, or succeeded) the column describes
  // something already superseded, so it stays hidden.
  const persisted = state ? (combined?.unmergedPersisted ?? null) : lastErrorMessage(link.lastError);

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
            disabled={state?.phase === 'running'}
            aria-label={`Sync now with ${link.remoteLabel || link.remoteBaseUrl}`}
            className="text-sm text-ink-secondary hover:text-[color:var(--color-accent)] disabled:opacity-50"
          >
            Sync now
          </button>
          <button
            type="button"
            onClick={() => onRemove(link)}
            disabled={state?.phase === 'running'}
            aria-label={`Remove link to ${link.remoteLabel || link.remoteBaseUrl}`}
            className="text-sm text-ink-secondary hover:text-rose-400 disabled:opacity-50"
          >
            Remove link
          </button>
        </div>
      </div>

      {/* F-06: elapsed seconds and nothing that resembles a progress bar. */}
      {state?.phase === 'running' && (
        <div role="status" className="mt-3 rounded-lg border border-glass-border bg-white/5 p-3 text-sm text-ink-secondary">
          <p>
            Syncing…{' '}
            <ElapsedTime since={state.startedAt} testId={`sync-link-elapsed-${link.id}`} />{' '}
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

      {state?.phase === 'done' && (
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
              aria-label={`Run anyway with ${link.remoteLabel || link.remoteBaseUrl}`}
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
  // `formError` belongs to the ADD form and is rendered beneath it. A failed
  // removal used to borrow it, so the dialog closed (reading as success) and
  // the explanation appeared under "Remote to link", labelled as a create
  // error and possibly below the fold. An error has to appear where the action
  // was taken.
  const [formError, setFormError] = useState<SyncCopy | null>(null);
  const [removeError, setRemoveError] = useState<SyncCopy | null>(null);

  const linked = links ?? [];
  const available = (remotes ?? []).filter((r) => !linked.some((l) => l.remoteId === r.id));

  const handleRun = async (link: SyncLink, force = false) => {
    setRuns((prev) => ({
      ...prev,
      [link.id]: { phase: 'running', startedAt: Date.now(), neverSynced: link.lastSyncedAt === null },
    }));
    try {
      // F-02: awaited, not fired and forgotten. The user stays on this row and
      // is shown what actually happened.
      const result = await runLink.mutateAsync({ id: link.id, force });
      setRuns((prev) => ({ ...prev, [link.id]: { phase: 'done', result } }));
    } catch (err) {
      setRuns((prev) => ({ ...prev, [link.id]: { phase: 'failed', error: syncErrorMessage(err) } }));
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

      {removeError && (
        <SyncErrorNotice copy={removeError} testId="sync-link-remove-error" />
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
                setRemoveError(null);
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
          // `isPending` guards a double confirm: ConfirmDialog only closes
          // AFTER onConfirm resolves, so its button stays live for the whole
          // request and a second click would fire a second DELETE — whose 404
          // would then report a failure for a removal that worked.
          if (!removeTarget || deleteLink.isPending) return;
          const id = removeTarget.id;
          setRemoveError(null);
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
            setRemoveError(syncErrorMessage(err));
          }
          setRemoveTarget(null);
        }}
      />
    </div>
  );
}
