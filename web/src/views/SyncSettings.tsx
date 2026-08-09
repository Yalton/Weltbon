/**
 * SyncSettings — /settings/sync (Plan F, Task 2).
 *
 * WHY THIS LIVES IN ACCOUNT SETTINGS, NOT UNIVERSE SETTINGS. `sync_remotes`
 * has no universe column: one saved remote is reused by every universe you
 * link to that peer. The universe-scoped half of sync (links, runs, conflicts)
 * lives in the Sync tab of universe settings instead. Keeping the two apart is
 * not cosmetic — deleting a remote here cascades to links in universes that
 * are not on screen, which is why the delete confirmation says so out loud.
 *
 * MASKING (mirrors LlmKeys' LLMKEY-03 treatment). `SyncRemote` carries no
 * plaintext token, and this view renders `••••{patSuffix}` and nothing else
 * for a saved one. A PAT exists only inside the form component the user is
 * typing into (components/SyncRemoteForm.tsx), which unmounts when they switch
 * rows or finish.
 *
 * ERROR COPY. Every failure rendered here goes through `syncErrorMessage` and
 * out via `SyncErrorNotice` — no error prose is written in this file. That
 * includes the list-load failure: a server that is down and one that refuses
 * the request look identical from this page unless the server's own message
 * survives.
 */

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

/**
 * The outcome of one row's "Test connection", plus the address it was run
 * against.
 *
 * `baseUrl` is what keeps the result honest over time. A handshake result is
 * only ever a statement about the address that was contacted, so when the row
 * changes address — the user edits it, or a refetch brings a new value — the
 * stored result stops applying and must disappear. Keying by id alone is
 * enough to keep rows from stealing each other's results, but not to stop a
 * green "Connected" line sitting under a host that was never reached.
 */
type TestState = {
  baseUrl: string;
  pending?: true;
  identity?: RemoteIdentity;
  error?: SyncCopy;
};

/** How a row names itself in an accessible label. */
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
    // timeout path. The pending marker is what stops a user facing a dead peer
    // from queueing handshakes with no feedback until each one times out.
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
                // Drop a result that was produced against a different address.
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
        // `sync_links.remote_id` is `onDelete: 'cascade'` (api/src/db/schema.ts:775):
        // the server drops every link to this remote, across the whole account.
        // The user is on an account-scoped page and cannot see those links, so
        // the confirmation has to name the blast radius.
        body={
          deleteTarget
            ? `Deleting ${deleteTarget.label ? `"${deleteTarget.label}"` : 'this remote'} also removes every sync link that used it, in every universe on this account. Your universes and their contents are untouched, but you would have to set those links up again.`
            : ''
        }
        confirmLabel="Delete remote"
        cancelLabel="Cancel"
        destructive
        onConfirm={async () => {
          // `isPending` guards a double confirm: ConfirmDialog only closes
          // AFTER onConfirm resolves, so its button stays live for the whole
          // request, and a second click would fire a second DELETE. This
          // delete cascades to every link that used this remote, across every
          // universe on the account (schema.ts:775, `onDelete: 'cascade'`) —
          // the most destructive action this surface offers — so the request
          // it could double-fire is a 404 reporting failure for a removal
          // that already succeeded on data whose blast radius is already
          // large. Mirrors SyncTab.tsx's remove-link guard.
          if (!deleteTarget || deleteRemote.isPending) return;
          const id = deleteTarget.id;
          setDeleteError(null);
          try {
            await deleteRemote.mutateAsync({ id });
            // Drop this row's local UI state along with the row itself, so no
            // stale handshake result or open editor outlives the remote it
            // described.
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
