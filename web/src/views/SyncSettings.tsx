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
 * for a saved one. A PAT is held only in the local state of the form the user
 * is currently typing into, and is dropped the moment the server accepts it.
 *
 * ERROR COPY. Every failure rendered here goes through `syncErrorMessage`
 * (lib/syncErrorCopy.ts) — no error prose is written in this file. On that
 * function's known-code path `detail` and `raw` are disjoint, so rendering
 * message + detail + a <details> disclosure prints nothing twice. (That is NOT
 * true of `lastErrorMessage`, which this view never calls — see that module's
 * docstring.)
 */

import { useId, useState } from 'react';
import {
  useSyncRemotes,
  useCreateSyncRemote,
  useUpdateSyncRemote,
  useDeleteSyncRemote,
  useTestSyncRemote,
  type SyncRemote,
  type RemoteIdentity,
} from '../hooks/useSyncRemotes';
import { syncErrorMessage, type SyncCopy } from '../lib/syncErrorCopy';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { formatRelative } from '../utils/formatRelative';

/**
 * The peer's own token page, or null if we must not link to it.
 *
 * The input is raw user-typed text, so this is a security boundary, not a
 * formatting helper: `new URL('javascript:alert(1)')` parses perfectly well
 * and would otherwise become a click-to-execute anchor inside the user's own
 * authenticated page. Only http/https survive; anything the URL constructor
 * rejects returns null and the caller renders no anchor at all.
 */
export function tokenMintUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // `origin + pathname` rather than `href` so a bare origin (whose pathname
  // normalizes to "/") does not yield a doubled slash before /settings.
  const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  return `${base}/settings/tokens`;
}

/** Render a `SyncCopy` — the only error-rendering shape in this view. */
function SyncErrorNotice({ copy, testId }: { copy: SyncCopy; testId?: string }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
    >
      <p>{copy.message}</p>
      {copy.detail && <p className="mt-1 text-xs opacity-90">{copy.detail}</p>}
      {copy.raw && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs opacity-80">Show details</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">{copy.raw}</pre>
        </details>
      )}
    </div>
  );
}

/** The F-05 wall: the token is minted on the OTHER instance. */
function PatGuidance() {
  return (
    <p
      data-testid="sync-pat-guidance"
      className="mt-2 text-sm leading-[1.55] text-ink-secondary"
    >
      The access token belongs to the <strong>other</strong> instance, not this
      one. Sign in to the instance at the address above, mint a personal access
      token there under Settings → API tokens, then paste it here. A token
      minted on this instance will always be rejected.
    </p>
  );
}

/** The "mint a token there" deep link, rendered only for a safe absolute URL. */
function TokenMintLink({ baseUrl }: { baseUrl: string }) {
  const href = tokenMintUrl(baseUrl);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="mt-1 inline-block text-xs text-[color:var(--color-accent)] underline"
    >
      Open that instance&rsquo;s token page
    </a>
  );
}

// ─── Add form ───────────────────────────────────────────────────────────────

function AddRemoteForm() {
  const create = useCreateSyncRemote();
  const ids = { label: useId(), baseUrl: useId(), pat: useId() };

  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  // The one place a plaintext PAT exists on the client. Cleared on success;
  // the component holds no copy anywhere else and never logs it.
  const [pat, setPat] = useState('');
  const [error, setError] = useState<SyncCopy | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync({ label: label.trim(), baseUrl: baseUrl.trim(), pat });
      setLabel('');
      setBaseUrl('');
      setPat('');
    } catch (err) {
      setError(syncErrorMessage(err));
    }
  };

  return (
    <section
      aria-labelledby="add-remote-heading"
      className="mt-8 rounded-xl border border-glass-border bg-white/5 p-5"
    >
      <h2 id="add-remote-heading" className="font-display text-lg font-semibold text-ink">
        Add a remote
      </h2>
      <form data-testid="add-remote-form" onSubmit={submit} className="mt-4 space-y-4">
        <div>
          <label htmlFor={ids.label} className="block text-sm text-ink-secondary">
            Label
          </label>
          <Input
            id={ids.label}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Laptop"
            className="mt-1"
          />
        </div>

        <div>
          <label htmlFor={ids.baseUrl} className="block text-sm text-ink-secondary">
            Base URL
          </label>
          <Input
            id={ids.baseUrl}
            type="text"
            inputMode="url"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://weltbon.example.com"
            className="mt-1"
          />
          <TokenMintLink baseUrl={baseUrl} />
        </div>

        <div>
          <label htmlFor={ids.pat} className="block text-sm text-ink-secondary">
            Access token
          </label>
          <Input
            id={ids.pat}
            type="password"
            required
            autoComplete="off"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            className="mt-1 font-mono"
          />
          <PatGuidance />
        </div>

        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Adding…' : 'Add remote'}
        </Button>

        {error && <SyncErrorNotice copy={error} testId="add-remote-error" />}
      </form>
    </section>
  );
}

// ─── Edit form ──────────────────────────────────────────────────────────────

/**
 * Editing exists because it is the prescribed remedy for two of the twelve
 * error codes: `remote-unauthorized` and `remote-key-undecryptable` both tell
 * the user to re-save the token on the remote. Without this form the app would
 * name a fix it gave no way to perform.
 */
function EditRemoteForm({ remote, onDone }: { remote: SyncRemote; onDone: () => void }) {
  const update = useUpdateSyncRemote();
  const ids = { label: useId(), baseUrl: useId(), pat: useId() };

  const [label, setLabel] = useState(remote.label);
  const [baseUrl, setBaseUrl] = useState(remote.baseUrl);
  // Blank means "keep the stored token" — the hook omits `pat` from the PATCH
  // body entirely in that case, because the server rejects an empty one.
  const [pat, setPat] = useState('');
  const [error, setError] = useState<SyncCopy | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({
        id: remote.id,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        pat: pat || undefined,
      });
      setPat('');
      onDone();
    } catch (err) {
      setError(syncErrorMessage(err));
    }
  };

  return (
    <form
      data-testid={`edit-remote-form-${remote.id}`}
      onSubmit={submit}
      className="rounded-lg border border-glass-border bg-white/5 p-4 space-y-3"
    >
      <div>
        <label htmlFor={ids.label} className="block text-sm text-ink-secondary">
          Label
        </label>
        <Input
          id={ids.label}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="mt-1"
        />
      </div>

      <div>
        <label htmlFor={ids.baseUrl} className="block text-sm text-ink-secondary">
          Base URL
        </label>
        <Input
          id={ids.baseUrl}
          type="text"
          inputMode="url"
          required
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="mt-1"
        />
        <TokenMintLink baseUrl={baseUrl} />
      </div>

      <div>
        <label htmlFor={ids.pat} className="block text-sm text-ink-secondary">
          Access token
        </label>
        <Input
          id={ids.pat}
          type="password"
          autoComplete="off"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="Leave blank to keep the saved token"
          className="mt-1 font-mono"
        />
        <p className="mt-1 text-xs text-ink-secondary">
          Paste a token only to replace the saved one. It is minted on the other
          instance, the same as when you added this remote.
        </p>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {error && <SyncErrorNotice copy={error} testId={`edit-remote-error-${remote.id}`} />}
    </form>
  );
}

// ─── View ───────────────────────────────────────────────────────────────────

type TestState = { identity?: RemoteIdentity; error?: SyncCopy };

export default function SyncSettings() {
  const { data, isPending, error: listError } = useSyncRemotes();
  const testRemote = useTestSyncRemote();
  const deleteRemote = useDeleteSyncRemote();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SyncRemote | null>(null);
  const [deleteError, setDeleteError] = useState<SyncCopy | null>(null);
  const [testState, setTestState] = useState<Record<string, TestState>>({});

  const handleTest = async (remote: SyncRemote) => {
    setTestState((prev) => ({ ...prev, [remote.id]: {} }));
    try {
      const res = await testRemote.mutateAsync({ id: remote.id });
      setTestState((prev) => ({ ...prev, [remote.id]: { identity: res.remote } }));
    } catch (err) {
      setTestState((prev) => ({ ...prev, [remote.id]: { error: syncErrorMessage(err) } }));
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
        own Sync tab.
      </p>

      {isPending && (
        <div className="mt-6 space-y-2" aria-busy="true" aria-label="Loading sync remotes">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-white/5" />
          ))}
        </div>
      )}

      {!isPending && listError && (
        <div
          role="alert"
          data-testid="sync-remotes-list-error"
          className="mt-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300"
        >
          Could not load your sync remotes. Refresh the page to try again.
        </div>
      )}

      {!isPending && !listError && data && data.length === 0 && (
        <EmptyState
          title="No sync remotes yet"
          body="Add the address of another Weltbon instance to start syncing universes with it."
        />
      )}

      {deleteError && <SyncErrorNotice copy={deleteError} testId="sync-remotes-delete-error" />}

      {!isPending && !listError && data && data.length > 0 && (
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
                  {/* actions */}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((remote) => {
                const state = testState[remote.id];
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
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => handleTest(remote)}
                          className="text-sm text-ink-secondary hover:text-[color:var(--color-accent)]"
                        >
                          Test connection
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId((cur) => (cur === remote.id ? null : remote.id))}
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
                          className="text-sm text-ink-secondary hover:text-rose-400"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>,
                  state && (state.identity || state.error) ? (
                    <tr key={`${remote.id}-status`}>
                      <td colSpan={5} className="pb-3">
                        {state.identity ? (
                          <p
                            data-testid={`remote-test-status-${remote.id}`}
                            className="text-xs text-emerald-300"
                          >
                            Connected — Weltbon {state.identity.weltbonVersion} · app{' '}
                            {state.identity.appVersion} · migration {state.identity.migrationHead}
                          </p>
                        ) : (
                          <SyncErrorNotice
                            copy={state.error as SyncCopy}
                            testId={`remote-test-status-${remote.id}`}
                          />
                        )}
                      </td>
                    </tr>
                  ) : null,
                  editingId === remote.id ? (
                    <tr key={`${remote.id}-edit`}>
                      <td colSpan={5} className="pb-4">
                        <EditRemoteForm remote={remote} onDone={() => setEditingId(null)} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      <AddRemoteForm />

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
          if (!deleteTarget) return;
          setDeleteError(null);
          try {
            await deleteRemote.mutateAsync({ id: deleteTarget.id });
            if (editingId === deleteTarget.id) setEditingId(null);
          } catch (err) {
            setDeleteError(syncErrorMessage(err));
          }
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
