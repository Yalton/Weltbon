
import { useState } from 'react';
import {
  useSyncRemotes,
  useDeleteSyncRemote,
  useTestSyncRemote,
  type SyncRemote,
  type RemoteIdentity,
} from '../hooks/useSyncRemotes';
import { syncErrorMessage, type SyncCopy } from '../lib/syncErrorCopy';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SyncErrorNotice } from '../components/SyncErrorNotice';
import { AddSyncRemoteForm, EditSyncRemoteForm } from '../components/SyncRemoteForm';
import { RemoteUniverseList } from '../components/RemoteUniverseList';
import { formatRelative } from '../utils/formatRelative';

type TestState = {
  baseUrl: string;
  pending?: true;
  identity?: RemoteIdentity;
  error?: SyncCopy;
};

function remoteName(remote: SyncRemote): string {
  return remote.label || remote.baseUrl;
}

export default function SyncSettings() {
  const { data, isPending, error: listError } = useSyncRemotes();
  const testRemote = useTestSyncRemote();
  const deleteRemote = useDeleteSyncRemote();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [browsingId, setBrowsingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SyncRemote | null>(null);
  const [deleteError, setDeleteError] = useState<SyncCopy | null>(null);
  const [testState, setTestState] = useState<Record<string, TestState>>({});

  const handleTest = async (remote: SyncRemote) => {
    // A handshake crosses the network to a user-supplied address, so an
    // unbounded wait is the ORDINARY case here — `remote-unreachable` is the
    setTestState((prev) => ({ ...prev, [remote.id]: { baseUrl: remote.baseUrl, pending: true } }));
    try {
      const res = await testRemote.mutateAsync({ id: remote.id });
      setTestState((prev) => ({
        ...prev,
        [remote.id]: { baseUrl: remote.baseUrl, identity: res.remote },
      }));
    } catch (err) {
      setTestState((prev) => ({
        ...prev,
        [remote.id]: { baseUrl: remote.baseUrl, error: syncErrorMessage(err) },
      }));
    }
  };

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Sync remotes
      </h1>
      <p className="mt-2 text-sm leading-[1.5] text-ink-secondary">
        A remote is another Weltbon instance this account can sync with. Remotes
        are saved once per account and reused by every universe you link to that
        instance; you choose which universes actually sync in each universe&rsquo;s
        own Sync tab, or adopt one this instance does not have yet from the
        list below.
      </p>

      {isPending && (
        <div className="mt-6 space-y-2" aria-busy="true" aria-label="Loading sync remotes">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      )}

      {/* A failed list is the FIRST error most users meet here, and only the
          server's own message says which failure it was — `syncErrorMessage`
          falls through to that message when the body carries no `code`, which
          a hand-written "refresh the page" would erase. */}
      {!isPending && listError && (
        <SyncErrorNotice copy={syncErrorMessage(listError)} testId="sync-remotes-list-error" />
      )}

      {!isPending && !listError && data && data.length === 0 && (
        <EmptyState
          title="No sync remotes yet"
          body="Add the address of another Weltbon instance to start syncing universes with it."
        />
      )}

      {deleteError && <SyncErrorNotice copy={deleteError} testId="sync-remotes-delete-error" />}

      {/* Gated on `data`, NOT on `!listError` — a deliberate divergence from
          LlmKeys.tsx. TanStack keeps the previous `data` while setting `error`
          on a FAILED REFETCH, and refetchOnWindowFocus is on by default, so
          `!listError && data` would blank a perfectly good list the moment the
          user tabs away and back during a network blip. A notice above a
          stale-but-real list beats showing neither. */}
      {!isPending && data && data.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table data-testid="sync-remotes-table" className="w-full text-sm">
            <caption className="sr-only">Sync remotes saved on this account</caption>
            <thead>
              <tr className="border-b border-glass-border">
                <th scope="col" className="pb-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Label
                </th>
                <th scope="col" className="pb-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Base URL
                </th>
                <th scope="col" className="pb-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Token
                </th>
                <th scope="col" className="pb-2 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Added
                </th>
                <th scope="col" className="pb-2 text-right text-xs font-medium uppercase tracking-wide text-ink-muted">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((remote) => {
                const stored = testState[remote.id];
                const state = stored && stored.baseUrl === remote.baseUrl ? stored : undefined;
                const name = remoteName(remote);
                return [
                  <tr key={remote.id} className="border-b border-glass-border/60 last:border-0">
                    <th scope="row" className="py-3 pr-4 text-left text-sm font-normal">
                      {remote.label || <span className="italic text-ink-muted">(unnamed)</span>}
                    </th>
                    <td className="py-3 pr-4 font-mono text-xs">{remote.baseUrl}</td>
                    {/* Only ever the suffix — the plaintext PAT is never on the wire. */}
                    <td className="py-3 pr-4 font-mono text-xs" data-testid={`remote-pat-${remote.id}`}>
                      {`••••${remote.patSuffix}`}
                    </td>
                    <td className="py-3 pr-4 text-xs">
                      <time dateTime={remote.createdAt} title={new Date(remote.createdAt).toLocaleString()}>
                        {formatRelative(remote.createdAt)}
                      </time>
                    </td>
                    <td className="py-3 text-right">
                      {/* Per-row aria-labels (house convention — views/Shares.tsx,
                          components/DictionaryTable.tsx): with more than one
                          remote, three buttons all named "Edit" are ambiguous
                          to a screen reader and unaddressable by name. */}
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => handleTest(remote)}
                          disabled={!!state?.pending}
                          aria-label={`Test connection to ${name}`}
                          className="text-sm text-ink-secondary hover:text-[color:var(--color-accent)] disabled:opacity-50"
                        >
                          {state?.pending ? 'Testing…' : 'Test connection'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setBrowsingId((cur) => (cur === remote.id ? null : remote.id))}
                          aria-label={
                            browsingId === remote.id
                              ? `Hide universes on ${name}`
                              : `Browse universes on ${name}`
                          }
                          className="text-sm text-ink-secondary hover:text-[color:var(--color-accent)]"
                        >
                          {browsingId === remote.id ? 'Hide universes' : 'Browse universes'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId((cur) => (cur === remote.id ? null : remote.id))}
                          aria-label={`Edit ${name}`}
                          className="text-sm text-ink-secondary hover:text-[color:var(--color-accent)]"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setDeleteTarget(remote);
                          }}
                          aria-label={`Delete ${name}`}
                          className="text-sm text-ink-secondary hover:text-rose-400"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>,
                  state ? (
                    <tr key={`${remote.id}-status`}>
                      <td colSpan={5} className="pb-3">
                        {state.error ? (
                          <SyncErrorNotice
                            copy={state.error}
                            testId={`remote-test-status-${remote.id}`}
                          />
                        ) : (
                          <p
                            data-testid={`remote-test-status-${remote.id}`}
                            role="status"
                            className={
                              state.pending ? 'text-xs text-ink-secondary' : 'text-xs text-emerald-300'
                            }
                          >
                            {state.pending ? (
                              `Testing ${remote.baseUrl}…`
                            ) : (
                              <>
                                Connected — Weltbon {state.identity?.weltbonVersion} · app{' '}
                                {state.identity?.appVersion} · migration{' '}
                                {state.identity?.migrationHead}
                              </>
                            )}
                          </p>
                        )}
                      </td>
                    </tr>
                  ) : null,
                  browsingId === remote.id ? (
                    <tr key={`${remote.id}-universes`}>
                      <td colSpan={5} className="pb-4">
                        <RemoteUniverseList remote={remote} />
                      </td>
                    </tr>
                  ) : null,
                  editingId === remote.id ? (
                    <tr key={`${remote.id}-edit`}>
                      <td colSpan={5} className="pb-4">
                        <EditSyncRemoteForm remote={remote} onDone={() => setEditingId(null)} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddSyncRemoteForm />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Delete remote"
        // The user is on an account-scoped page and cannot see those links, so
        body={
          deleteTarget
            ? `Deleting ${deleteTarget.label ? `"${deleteTarget.label}"` : 'this remote'} also removes every sync link that used it, in every universe on this account. Your universes and their contents are untouched, but you would have to set those links up again.`
            : ''
        }
        confirmLabel="Delete remote"
        cancelLabel="Cancel"
        destructive
        onConfirm={async () => {
          // it could double-fire is a 404 reporting failure for a removal
          // large. Mirrors SyncTab.tsx's remove-link guard.
          if (!deleteTarget || deleteRemote.isPending) return;
          const id = deleteTarget.id;
          setDeleteError(null);
          try {
            await deleteRemote.mutateAsync({ id });
            if (editingId === id) setEditingId(null);
            if (browsingId === id) setBrowsingId(null);
            setTestState((prev) => {
              if (!(id in prev)) return prev;
              const next = { ...prev };
              delete next[id];
              return next;
            });
          } catch (err) {
            setDeleteError(syncErrorMessage(err));
          }
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
