/**
 * Plan F (Task 2) — the two forms behind /settings/sync.
 *
 * Two exported components in one file, deliberately NOT one component with a
 * `mode` flag. They differ in required-vs-optional PAT, first-time guidance vs
 * replace hint, chrome (a titled section vs an inline row expansion), submit
 * label, and the presence of a Cancel — threading a flag through six branches
 * to save the ~40 shared lines would make both harder to read than either is
 * now. What they genuinely share (`PatGuidance`, `TokenMintLink`) is factored
 * out below; the PAT lifetime rule is stated once, on the state itself.
 *
 * PAT LIFETIME. Each form holds the plaintext token in its own local state,
 * and only while mounted. `EditSyncRemoteForm` mounts per row, so switching
 * rows unmounts it and destroys the typed token — it is not parent state keyed
 * by id, which would survive the switch and leak a token typed for one remote
 * into the form for another.
 */

import { useId, useState } from 'react';
import { useCreateSyncRemote, useUpdateSyncRemote, type SyncRemote } from '../hooks/useSyncRemotes';
import { syncErrorMessage, type SyncCopy } from '../lib/syncErrorCopy';
import { tokenMintUrl } from '../lib/tokenMintUrl';
import { SyncErrorNotice } from './SyncErrorNotice';
import { Input } from './ui/Input';
import { Button } from './ui/Button';

/** The F-05 wall: every new user pastes a token minted on the WRONG instance. */
function PatGuidance() {
  return (
    <p data-testid="sync-pat-guidance" className="mt-2 text-sm leading-[1.55] text-ink-secondary">
      The access token belongs to the <strong>other</strong> instance, not this
      one. Sign in to the instance at the address above, mint a personal access
      token there under Settings → API tokens, then paste it here. A token
      minted on this instance will always be rejected.
    </p>
  );
}

/**
 * Deep link to the peer's token page. Renders nothing unless `tokenMintUrl`
 * returns a safe absolute http(s) URL — see that module for why a parsed URL
 * is not by itself a safe one.
 */
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

// ─── Add ────────────────────────────────────────────────────────────────────

export function AddSyncRemoteForm() {
  const create = useCreateSyncRemote();
  const ids = { label: useId(), baseUrl: useId(), pat: useId() };

  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
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

// ─── Edit ───────────────────────────────────────────────────────────────────

/**
 * Editing exists because it is the prescribed remedy for two of the twelve
 * error codes: `remote-unauthorized` and `remote-key-undecryptable` both tell
 * the user to re-save the token on the remote. Without this form the app would
 * name a fix it gave no way to perform.
 */
export function EditSyncRemoteForm({
  remote,
  onDone,
}: {
  remote: SyncRemote;
  onDone: () => void;
}) {
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
      className="space-y-3 rounded-lg border border-glass-border bg-white/5 p-4"
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
