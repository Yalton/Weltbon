
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useSyncLinks,
  useCreateSyncLink,
  useDeleteSyncLink,
  useRunSyncLink,
  useSetLinkAutoSync,
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
import { syncStatusCopy, type SyncStatusTone } from '../lib/syncStatusCopy';
import { SyncErrorNotice } from './SyncErrorNotice';
import { SyncRunSummary } from './SyncRunSummary';
import { SyncConflictList } from './SyncConflictList';
import { ConfirmDialog } from './ConfirmDialog';

type RunState =
  | { phase: 'running'; startedAt: number; neverSynced: boolean }
  | { phase: 'done'; result: SyncRunResult }
  | { phase: 'failed'; error: SyncCopy };

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
  return (
    <span data-testid={testId} aria-hidden="true">
      {Math.max(0, Math.floor((now - since) / 1000))}s
    </span>
  );
}

const STATUS_TONE_CLASS: Record<SyncStatusTone, string> = {
  ok: 'text-ink-secondary',
  busy: 'text-[color:var(--color-accent)]',
  waiting: 'text-amber-500 dark:text-amber-400',
  paused: 'text-rose-500 dark:text-rose-400',
};

function SyncLinkRow({
  link,
  state,
  onRun,
  onRemove,
  onSetAutoSync,
  autoSyncPending,
}: {
  link: SyncLink;
  state: RunState | undefined;
  onRun: (link: SyncLink, force?: boolean) => void;
  onRemove: (link: SyncLink) => void;
  onSetAutoSync: (link: SyncLink, autoSync: boolean) => void;
  autoSyncPending: boolean;
}) {
  // case, which is the likeliest failure of a multi-minute request and the one
  const combined = state?.phase === 'failed' ? combineRunError(state.error, link.lastError) : null;
  const runError = combined?.copy ?? null;
  const persisted = state ? (combined?.unmergedPersisted ?? null) : lastErrorMessage(link.lastError);

  // #44 (AS-10): driven by the SERVER's `link.status`/`pausedReason`/
  // auto-sync run started by the scheduler has no such local origin, so this
  const status = syncStatusCopy(link, new Date());

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
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            <input
              type="checkbox"
              checked={link.autoSync}
              disabled={autoSyncPending}
              onChange={(e) => onSetAutoSync(link, e.target.checked)}
              aria-label={`Auto-sync with ${link.remoteLabel || link.remoteBaseUrl}`}
              className="disabled:opacity-50"
            />
            Auto-sync
          </label>
          <span
            data-testid={`sync-link-status-${link.id}`}
            className={`text-xs ${STATUS_TONE_CLASS[status.tone]}`}
          >
            {/* `<time>` ONLY on the branch that is actually a time. This used
                to wrap every status string, so a screen reader was handed
                `<time datetime="2026-…">Paused: sign in again…</time>` and
                `<time datetime="2026-…">Retrying in 5m</time>` — a timestamp
                announcement attached to a sentence that is not a timestamp,
                and one that names a moment the sentence has nothing to do
                with. `status.kind` is what distinguishes them; `tone` cannot,
                because 'ok' covers three different branches. */}
            {status.kind === 'synced' && link.lastSyncedAt ? (
              <time dateTime={link.lastSyncedAt} title={new Date(link.lastSyncedAt).toLocaleString()}>
                {status.text}
              </time>
            ) : (
              status.text
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

// #44 (AS-10): modest poll while the tab is mounted, so a run the SCHEDULER
const LINKS_REFETCH_INTERVAL_MS = 15_000;

export function SyncTab({ universeId }: { universeId: string }) {
  const { data: links, isPending, error: listError } = useSyncLinks(universeId, {
    refetchInterval: LINKS_REFETCH_INTERVAL_MS,
  });
  const { data: remotes, isPending: remotesPending, error: remotesError } = useSyncRemotes();
  const createLink = useCreateSyncLink(universeId);
  const deleteLink = useDeleteSyncLink(universeId);
  const runLink = useRunSyncLink(universeId);
  const setAutoSync = useSetLinkAutoSync(universeId);

  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [chosenRemote, setChosenRemote] = useState('');
  const [removeTarget, setRemoveTarget] = useState<SyncLink | null>(null);
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
      const result = await runLink.mutateAsync({ id: link.id, force });
      setRuns((prev) => ({ ...prev, [link.id]: { phase: 'done', result } }));
    } catch (err) {
      setRuns((prev) => ({ ...prev, [link.id]: { phase: 'failed', error: syncErrorMessage(err) } }));
    }
  };

  // Errors are silently absorbed here on purpose: `setAutoSync` is a fire-and
  // -forget checkbox toggle, not a form submission, and the mutation's own
  // cache (still holding the pre-toggle value on failure) is what makes the
  const handleSetAutoSync = (link: SyncLink, autoSync: boolean) => {
    setAutoSync.mutate({ linkId: link.id, autoSync });
  };

  return (
    <div>
      <h2 className="text-lg font-medium mb-2">Sync</h2>
      <p className="text-sm text-ink-muted mb-3">
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

      {/* THE GATE, GENERALLY (also SyncSettings.tsx:120, SyncConflictList.tsx:268).
          TanStack sets `isPending: false` with `data` left `undefined` on a
          FAILED FIRST FETCH — there is no list yet, only an error. A branch that
          infers "empty" from the absence of data, without excluding that state,
          cannot tell "the server said there are none" from "the server never
          answered", and prints the former — a confident, false sentence — with
          no error in sight. Every EMPTY/POSITIVE-STATE branch on this feature
          must therefore check `!listError` before treating a missing list as a
          known-empty one. (The positive list render below is gated differently,
          on the data itself, so a stale-but-real list survives a failed
          REFETCH instead of vanishing — see the comment there.) Any list added
          to this surface later needs the same `!listError` check here. */}
      {!isPending && !listError && linked.length === 0 && (
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
              onSetAutoSync={handleSetAutoSync}
              autoSyncPending={setAutoSync.isPending && setAutoSync.variables?.linkId === link.id}
            />
          ))}
        </ul>
      )}

      <div className="mt-6 border-t border-glass-border pt-4">
        {/* The pending branch comes FIRST because both branches below make
            positive claims about a list that has not arrived. `remotes` is
            `undefined` mid-fetch, so `remotes.length === 0` is falsy and the
            "already linked" branch would win — telling the user, in a complete
            sentence, something not yet known to be true.

            THE ERROR BRANCH COMES NEXT, for the same reason: on a failed fetch
            `remotes` is ALSO `undefined` (see the gate comment above the links
            list), and without this check "already linked" would win here too —
            flatly untrue, with the real error never shown and no way to link
            anything. */}
        {remotesPending ? (
          <div
            className="h-9 animate-pulse rounded-lg bg-white/5"
            aria-busy="true"
            aria-label="Loading sync remotes"
          />
        ) : remotesError ? (
          <SyncErrorNotice copy={syncErrorMessage(remotesError)} testId="sync-remotes-list-error" />
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
                className="rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
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
              className="rounded-md btn-accent text-sm px-3 py-2 disabled:opacity-50"
            >
              Link universe
            </button>
          </div>
        )}
        {formError && <SyncErrorNotice copy={formError} testId="sync-link-create-error" />}
      </div>


      <SyncConflictList universeId={universeId} />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title="Remove sync link"
        // The stored base snapshot goes with the row, so a re-linked pair has
        body={
          removeTarget
            ? `This universe will stop syncing with ${removeTarget.remoteLabel || removeTarget.remoteBaseUrl}. Nothing is deleted on either instance, but linking them again would start from a fresh full sync.`
            : ''
        }
        confirmLabel="Remove link"
        cancelLabel="Cancel"
        destructive
        onConfirm={async () => {
          if (!removeTarget || deleteLink.isPending) return;
          const id = removeTarget.id;
          setRemoveError(null);
          try {
            await deleteLink.mutateAsync({ id });
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
