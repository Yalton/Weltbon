
import { useId, useState } from 'react';
import { useCreateSyncRemote, useUpdateSyncRemote, type SyncRemote } from '../hooks/useSyncRemotes';
import { syncErrorMessage, type SyncCopy } from '../lib/syncErrorCopy';
import { tokenMintUrl } from '../lib/tokenMintUrl';
import { SyncErrorNotice } from './SyncErrorNotice';
import { Input } from './ui/Input';
import { Button } from './ui/Button';

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
