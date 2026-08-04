/**
 * SyncConflictList — the LWW-loser review surface (Plan F, Task 4).
 *
 * WHY IT EXISTS. Last-write-wins compares wall clocks across two instances, so
 * skew can pick the "wrong" winner. That is only tolerable because the loser is
 * never silently discarded: the merge writes it to `sync_conflicts`, this list
 * shows it, and Restore writes it back. This component is the whole of the
 * user-visible half of that guarantee.
 *
 * F-03 — THE LOSER PLUS A DEEP LINK, NEVER A DIFF. The ledger stores ONLY
 * `loserPayload`; there is no winner payload anywhere on the wire. A "diff" here
 * could only be fabricated by re-fetching the current row and pretending the
 * result is what won — which it may not be, since anything could have edited it
 * since. So the losing version is shown raw behind a disclosure, and the current
 * row is offered as a link for the user to look at themselves.
 *
 * F-04 — ONE FLAT LIST, IN THE SERVER'S ORDER. No grouping of content versus
 * positional collections: `graphPositions` losing is not a different KIND of
 * event from `entries` losing, and a grouping would have to invent a taxonomy
 * over `tableName`, which is opaque text. The route promises newest first and
 * this component renders `conflicts.map` with no sort of its own — a client-side
 * sort would silently replace the contract this surface exists to render, and
 * would reorder differently again the moment two rows share a `createdAt`
 * (ordinary, since D-13 records a merge's losses as one batch).
 *
 * OPAQUE IDENTIFIERS. `tableName` is a manifest COLLECTION name (`graphPositions`,
 * not `graph_positions` — D-14) and may be the literal string `universe` for the
 * B-06 singleton; `rowId` is whatever that collection's key function produced —
 * a uuid for most, `entryId` for `graphPositions`, the literal `universe` for the
 * singleton. Both are rendered verbatim and neither is parsed. There is
 * deliberately no display-name map over `tableName`: a fixed set is exactly the
 * assumption the column does not support, and an unmapped collection would
 * render blank rather than merely unpolished.
 *
 * ERROR COPY comes from `syncErrorMessage` and renders through the shared
 * `SyncErrorNotice`. No error prose is written in this file. A mutation failure
 * appears on the ROW the user clicked, not at the top of the surface — the
 * lesson SyncTab already paid for with its remove-link error.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useSyncConflicts,
  useResolveConflict,
  useRestoreConflict,
  type SyncConflict,
} from '../hooks/useSyncConflicts';
import { syncErrorMessage, type SyncCopy } from '../lib/syncErrorCopy';
import { SyncErrorNotice } from './SyncErrorNotice';
import { formatRelative } from '../utils/formatRelative';

/**
 * The collections whose `rowId` genuinely addresses a page in this app, and
 * what to call the destination.
 *
 * DELIBERATELY SMALL. A link that 404s is worse than no link on a surface whose
 * point is "your data was not lost" — so a collection appears here only when its
 * key function's output IS the id in the route:
 *
 *   - `entries`        → the entry page, keyed on the entry id.
 *   - `graphPositions` → the SAME entry page: this collection keys on `entryId`
 *     (manifest.ts), and the graph itself has no per-node URL, so the entry the
 *     position belongs to is the closest addressable thing.
 *   - `maps`, `diagrams` → their editors, keyed on the row id.
 *
 * Everything else — `links`, `mapPins`, `timelinePins`, `dictionaryWords`,
 * `assets`, `terrainTypes`, the `universe` singleton, … — has no per-row route,
 * and gets no link rather than a guess. An unknown/new collection lands here too,
 * which is the safe direction.
 */
const ROW_LINKS: Record<string, { path: (universeId: string, rowId: string) => string; label: string }> = {
  entries: { path: (u, r) => `/universes/${u}/entries/${r}`, label: 'Open the current entry' },
  graphPositions: { path: (u, r) => `/universes/${u}/entries/${r}`, label: 'Open the current entry' },
  maps: { path: (u, r) => `/universes/${u}/maps/${r}`, label: 'Open the current map' },
  diagrams: { path: (u, r) => `/universes/${u}/diagrams/${r}`, label: 'Open the current diagram' },
};

/**
 * Who won, in words.
 *
 * `winner` is a `text` column holding 'local' or 'remote' today, so the third
 * branch is not defensive noise — it is what keeps a future value from
 * rendering an empty sentence or, worse, silently taking the 'local' branch.
 */
function winnerSentence(winner: string): string {
  if (winner === 'remote') {
    return 'The remote instance won. The version below is the local one, which was replaced.';
  }
  if (winner === 'local') {
    return 'This instance won. The version below came from the remote instance and was not applied.';
  }
  return `Recorded winner: ${winner}. The version below is the one that was set aside.`;
}

function ConflictRow({
  conflict,
  universeId,
  busy,
  error,
  onRestore,
  onDismiss,
}: {
  conflict: SyncConflict;
  universeId: string;
  busy: boolean;
  error: SyncCopy | null;
  onRestore: (c: SyncConflict) => void;
  onDismiss: (c: SyncConflict) => void;
}) {
  const target = ROW_LINKS[conflict.tableName];
  // `${tableName} ${rowId}` rather than a prose name: both are opaque text, and
  // it is what makes two buttons on two rows distinguishable to a screen reader.
  const what = `${conflict.tableName} ${conflict.rowId}`;

  return (
    <li
      data-testid={`sync-conflict-row-${conflict.id}`}
      className="border-b border-glass-border/60 py-4 last:border-0"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm text-ink">
            <span>{conflict.tableName}</span>{' '}
            <code className="font-mono text-xs text-ink-muted">{conflict.rowId}</code>
          </p>
          <p className="mt-1 text-sm text-ink-secondary">{winnerSentence(conflict.winner)}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-ink-secondary">
            <time
              dateTime={conflict.createdAt}
              title={new Date(conflict.createdAt).toLocaleString()}
            >
              {formatRelative(conflict.createdAt)}
            </time>
          </span>
          <button
            type="button"
            onClick={() => onRestore(conflict)}
            disabled={busy}
            aria-label={`Restore the replaced version of ${what}`}
            className="text-sm text-ink-secondary hover:text-[color:var(--color-accent)] disabled:opacity-50"
          >
            Restore this version
          </button>
          <button
            type="button"
            onClick={() => onDismiss(conflict)}
            disabled={busy}
            aria-label={`Dismiss the conflict for ${what}`}
            className="text-sm text-ink-secondary hover:text-rose-400 disabled:opacity-50"
          >
            Dismiss
          </button>
        </div>
      </div>

      {target && (
        <p className="mt-2 text-sm">
          <Link
            to={target.path(universeId, conflict.rowId)}
            className="text-[color:var(--color-accent)] hover:underline"
          >
            {target.label}
          </Link>
        </p>
      )}

      {/* F-03: the raw losing payload, collapsed. Raw rather than prettified per
          collection — a per-collection renderer would need the same fixed set of
          collection names this file refuses to assume, and would show nothing at
          all for one it did not know. */}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-ink-secondary">
          Show the version that was set aside
        </summary>
        <pre
          data-testid={`sync-conflict-payload-${conflict.id}`}
          className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/5 p-2 text-xs text-ink-secondary"
        >
          {JSON.stringify(conflict.loserPayload, null, 2)}
        </pre>
      </details>

      {error && <SyncErrorNotice copy={error} testId={`sync-conflict-error-${conflict.id}`} />}
    </li>
  );
}

export function SyncConflictList({ universeId }: { universeId: string }) {
  const { data, isPending, error: listError } = useSyncConflicts(universeId);
  const restore = useRestoreConflict(universeId);
  const resolve = useResolveConflict(universeId);

  // Per row, so a failure appears where the user clicked. A single shared slot
  // would attribute one row's failure to whichever row the eye landed on.
  const [rowErrors, setRowErrors] = useState<Record<string, SyncCopy>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  // NO SORT. The server returned these newest first; re-deriving that here would
  // replace its contract with a different one.
  const conflicts = data ?? [];

  const act = async (conflict: SyncConflict, run: (vars: { id: string }) => Promise<unknown>) => {
    setBusyId(conflict.id);
    setRowErrors((prev) => {
      if (!(conflict.id in prev)) return prev;
      const next = { ...prev };
      delete next[conflict.id];
      return next;
    });
    try {
      await run({ id: conflict.id });
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [conflict.id]: syncErrorMessage(err) }));
    }
    setBusyId(null);
  };

  return (
    <div className="mt-8 border-t border-glass-border pt-4">
      <h3 className="text-base font-medium">Conflicts</h3>
      <p className="mt-1 text-sm text-neutral-500">
        When both instances changed the same thing, the more recent change is kept and the other
        version is recorded here so nothing is lost. This list covers this universe only.
      </p>

      {isPending && (
        <div className="mt-4 space-y-2" aria-busy="true" aria-label="Loading sync conflicts">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      )}

      {/* The server's own message survives: a server that is down and one that
          refuses the request look identical from here without it. */}
      {!isPending && listError && (
        <SyncErrorNotice copy={syncErrorMessage(listError)} testId="sync-conflicts-list-error" />
      )}

      {!isPending && conflicts.length === 0 && (
        <p data-testid="sync-conflicts-empty" className="mt-4 text-sm text-ink-secondary">
          No sync conflicts to review in this universe.
        </p>
      )}

      {/* Gated on the data rather than on `!listError` (same reasoning as
          SyncTab): TanStack keeps the previous rows while setting `error` on a
          FAILED REFETCH, and a notice above a stale list beats neither. */}
      {conflicts.length > 0 && (
        <ul className="mt-4" data-testid="sync-conflicts-list">
          {conflicts.map((c) => (
            <ConflictRow
              key={c.id}
              conflict={c}
              universeId={universeId}
              busy={busyId === c.id}
              error={rowErrors[c.id] ?? null}
              onRestore={(x) => act(x, restore.mutateAsync)}
              onDismiss={(x) => act(x, resolve.mutateAsync)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
