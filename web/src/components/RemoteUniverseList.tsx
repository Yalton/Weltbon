/**
 * What one remote holds, and what this instance can do about it (A-04, A-07,
 * A-12).
 *
 * PLACEMENT. This belongs to the remote's row in /settings/sync, not to a
 * universe's Sync tab: F-01 puts links under the universe they belong to, and
 * an unadopted universe has no local settings page for a tab to live in.
 *
 * ADOPT IS TWO REQUESTS, ON PURPOSE (A-06). Adoption creates the universe and
 * the link; the CONTENT arrives through the ordinary run, so this component
 * calls the same `useRunSyncLink` the Sync tab uses and renders the same
 * summary. A dedicated long-running adopt endpoint would have needed its own
 * progress story, its own error mapping and its own copy about slow first syncs
 * — three things F-02 and F-06 already settled.
 *
 * ERROR COPY. Every failure goes through `syncErrorMessage`; no error prose is
 * written in this file.
 */
import { useState } from 'react';
import {
  useRemoteUniverses,
  useAdoptUniverse,
  useLinkRemoteUniverse,
  type RemoteUniverse,
} from '../hooks/useAdoptUniverse';
import { useRunSyncLink, type SyncRunResult } from '../hooks/useSyncLinks';
import type { SyncRemote } from '../hooks/useSyncRemotes';
import { syncErrorMessage, type SyncCopy } from '../lib/syncErrorCopy';
import { SyncErrorNotice } from './SyncErrorNotice';
import { SyncRunSummary } from './SyncRunSummary';
import { formatRelative } from '../utils/formatRelative';

export function RemoteUniverseList({ remote }: { remote: SyncRemote }) {
  const { data, isPending, error } = useRemoteUniverses(remote.id);

  if (isPending) {
    return (
      <div className="space-y-2 py-2" aria-busy="true" aria-label={`Loading universes on ${remote.label || remote.baseUrl}`}>
        {[0, 1].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-white/5" />
        ))}
      </div>
    );
  }

  if (error) {
    return <SyncErrorNotice copy={syncErrorMessage(error)} testId={`remote-universes-error-${remote.id}`} />;
  }

  if (!data || data.length === 0) {
    return <p className="py-2 text-xs text-ink-secondary">That instance has no universes on this account.</p>;
  }

  return (
    <div className="py-2">
      {/* F-06: the run this list triggers is the first sync, and a universe
          with images makes it a minutes-long request. Said once, above the
          list, rather than per row. */}
      <p className="pb-2 text-xs text-ink-muted">
        Adopting copies the universe onto this instance and keeps its id, so the two stay
        in sync. The first sync can take several minutes if the universe contains images.
      </p>
      <ul className="space-y-1">
        {data.map((u) => (
          <RemoteUniverseRow key={u.id} remote={remote} universe={u} />
        ))}
      </ul>
    </div>
  );
}

/**
 * One universe on the remote, and the single action its state affords.
 *
 * Its own component so `useRunSyncLink` can be called with THIS row's universe
 * id. A list-level hook call would have no universe to name and would need an
 * empty-string sentinel — which is both a smell and a live bug the day that
 * hook's per-universe invalidation starts mattering.
 */
function RemoteUniverseRow({ remote, universe }: { remote: SyncRemote; universe: RemoteUniverse }) {
  const adopt = useAdoptUniverse();
  const linkExisting = useLinkRemoteUniverse();
  const run = useRunSyncLink(universe.id);

  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<SyncCopy | null>(null);
  const [result, setResult] = useState<SyncRunResult | null>(null);

  const handleAdopt = async () => {
    setBusy(true);
    setCopy(null);
    try {
      const link = await adopt.mutateAsync({ remoteId: remote.id, universeId: universe.id });
      // Only after the adopt RESOLVES — running against a link that was never
      // created would report a second, misleading failure over the real one.
      setResult(await run.mutateAsync({ id: link.id }));
    } catch (err) {
      setCopy(syncErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleLink = async () => {
    setBusy(true);
    setCopy(null);
    try {
      await linkExisting.mutateAsync({ remoteId: remote.id, universeId: universe.id });
    } catch (err) {
      setCopy(syncErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center justify-between gap-4 border-b border-glass-border/60 py-2 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-sm">{universe.name}</p>
        <p className="text-xs text-ink-muted">
          <time dateTime={universe.updatedAt} title={new Date(universe.updatedAt).toLocaleString()}>
            updated {formatRelative(universe.updatedAt)}
          </time>
        </p>
        {copy && <SyncErrorNotice copy={copy} testId={`adopt-error-${universe.id}`} />}
        {result && <SyncRunSummary result={result} testId={`adopt-run-${universe.id}`} />}
      </div>
      {/* Per-row aria-labels (house convention — views/Shares.tsx,
          components/DictionaryTable.tsx): several buttons all named "Adopt"
          are ambiguous to a screen reader and unaddressable by name. */}
      {universe.localState === 'absent' && (
        <button
          type="button"
          onClick={handleAdopt}
          disabled={busy}
          aria-label={`Adopt ${universe.name}`}
          className="shrink-0 text-sm text-ink-secondary hover:text-[color:var(--color-accent)] disabled:opacity-50"
        >
          {busy ? 'Adopting…' : 'Adopt'}
        </button>
      )}
      {universe.localState === 'present' && (
        <button
          type="button"
          onClick={handleLink}
          disabled={busy}
          aria-label={`Link ${universe.name}`}
          className="shrink-0 text-sm text-ink-secondary hover:text-[color:var(--color-accent)] disabled:opacity-50"
        >
          {busy ? 'Linking…' : 'Link'}
        </button>
      )}
      {universe.localState === 'linked' && (
        <span className="shrink-0 text-xs text-emerald-300">Linked</span>
      )}
    </li>
  );
}
