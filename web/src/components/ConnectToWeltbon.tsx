/**
 * OB-02 (#42). The one-button connect flow's UI, driving `useConnectToWeltbon`.
 *
 * Three panes, chosen by the hook's `step`/`failedStep` — not by a locally
 * tracked "which screen am I on" flag, because the hook is already the source
 * of truth for where the flow is:
 *
 *   - credentials  <- step === 'idle', OR failedStep === 'authenticating'.
 *     A rejected sign-in is the one failure that belongs back on the form —
 *     everything the user typed was wrong at the source, so re-typing it is
 *     the only useful next step. The form stays mounted alongside the error
 *     so "Try again" (retry(), reusing the credentials already sent) and
 *     "Connect" (start(), sending edited ones) are both on offer.
 *   - picker       <- step === 'choosing'.
 *   - progress     <- everything else, INCLUDING every other failure. A
 *     failure at 'adopting' or 'syncing' must not bounce the user back to
 *     the credential form — their universe may already be adopted, and
 *     asking them to sign in again would be the exact bad recovery path
 *     this feature exists to remove (see useConnectToWeltbon.ts's docstring).
 *
 * PASSWORD LIFETIME. Held in local `useState` only, cleared the instant
 * `start` resolves — same rule as the PAT in SyncRemoteForm.tsx:12, applied
 * to a password instead of a token. `start()` never rejects (the hook
 * catches internally and reports failure via state), so an unconditional
 * clear after the `await` is correct for both outcomes.
 *
 * COPY. No visible string here may contain "remote", "link", "token", or
 * "PAT" — the user is connecting to Weltbon, not registering a remote. THAT
 * INCLUDES ERROR TEXT, which is why no pane below renders `error.message`: the
 * server's real messages are operator prose ("Invalid remote URL: not a valid
 * absolute URL", "The remote rejected the stored PAT"), so every failure goes
 * through `connectErrorMessage()` in lib/connectErrorCopy.ts, which is keyed on
 * the machine `code` and never derives a sentence from the thrown text.
 *
 * NAMING THE STEP. The Definition of Done requires every failure to name the
 * step it happened on, so both failure surfaces lead with "Stopped while
 * <gerund>." from the same STEP_GERUND map the fallback sentence uses — one
 * source, so the headline and the sentence cannot disagree about one failure.
 *
 * A FAILED FIRST SYNC LANDS IN THE UNIVERSE, NOT IN THIS COMPONENT. OB-04 is
 * explicit that a step-4 failure leaves "a real but empty universe" and that
 * "the user lands in it with a persistent 'first sync didn't finish — Retry'
 * banner rather than being bounced back to a form". That banner lives on
 * EntryList and is driven by persisted link state, so it survives reload — but
 * it is unreachable unless something navigates there, and pressing Cancel in
 * this pane would unmount the hook and discard the universe id entirely. Hence
 * the effect below fires `onDone` for `failedStep === 'syncing'` with a
 * universe in hand, exactly as it does for `done`. Failures at steps 1-3 have
 * no universe to land in and keep their in-pane retry.
 *
 * server reports as already `'present'` on this instance is a dead end: the
 * server's 409 (`SyncUniverseAlreadyLocalError`) covers both `'present'` and
 * `'linked'`, but the hook's recovery only works for `'linked'` (it finds an
 * existing sync link to resume through) — for `'present'` there is by
 * definition no link yet, the lookup fails, and the original error rethrows
 * every time, including on retry(). There is no code path here that can ever
 * succeed for that entry, so it is disabled rather than offered: bringing a
 * universe you already have a local copy of under sync is a deliberate,
 * advanced action that belongs at Settings → Sync (OB-05), not a silent trap
 * in the one-button flow. `'absent'` (the normal case) and `'linked'` (whose
 * recovery demonstrably resumes a sync) stay enabled.
 */
import { useEffect, useId, useState } from 'react';
import { useConnectToWeltbon, type ConnectStep } from '../hooks/useConnectToWeltbon';
import {
  connectErrorMessage,
  STEP_GERUND,
  type ConnectFailureStep,
} from '../lib/connectErrorCopy';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { Loading } from './ui/Loading';
import { formatRelative } from '../utils/formatRelative';

const STEP_LABEL: Record<ConnectStep, string> = {
  authenticating: 'Signing you in…',
  discovering: 'Looking for your universes…',
  choosing: 'Choose a universe',
  adopting: 'Setting up your universe…',
  syncing: 'Bringing in your content…',
  done: 'All set',
};

function asFailureStep(step: ConnectStep | null): ConnectFailureStep | null {
  return step === 'authenticating' || step === 'discovering' || step === 'adopting' || step === 'syncing'
    ? step
    : null;
}

function failureCopy(
  failedStep: ConnectStep | null,
  error: { message: string; code?: string } | null,
): { headline: string; message: string } {
  const s = asFailureStep(failedStep);
  if (!s) return { headline: 'Something stopped the connection.', message: 'Try again in a moment.' };
  return {
    headline: `Stopped while ${STEP_GERUND[s]}.`,
    message: connectErrorMessage(error, s),
  };
}

export function ConnectToWeltbon(props: { onDone(universeId: string): void; onCancel(): void }) {
  const { onDone, onCancel } = props;
  const state = useConnectToWeltbon();
  const { step, failedStep, error, universes, universeId, start, chooseUniverse, retry } = state;

  // pull failed after the universe was already adopted (OB-04). The second is
  const firstSyncFailed = failedStep === 'syncing' && !!universeId;
  useEffect(() => {
    if ((step === 'done' || firstSyncFailed) && universeId) onDone(universeId);
  }, [step, firstSyncFailed, universeId, onDone]);

  const showCredentials = step === 'idle' || failedStep === 'authenticating';
  const showPicker = !showCredentials && step === 'choosing';

  return (
    <div className="space-y-4">
      {showCredentials && (
        <CredentialsPane
          start={start}
          retry={retry}
          onCancel={onCancel}
          error={failedStep === 'authenticating' ? error : null}
        />
      )}
      {showPicker && <PickerPane universes={universes} chooseUniverse={chooseUniverse} onCancel={onCancel} />}
      {!showCredentials && !showPicker && (
        <ProgressPane
          step={step as ConnectStep}
          failedStep={failedStep}
          error={error}
          retry={retry}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function CredentialsPane({
  start,
  retry,
  onCancel,
  error,
}: {
  start: (args: { baseUrl: string; email: string; password: string }) => Promise<void>;
  retry?: () => Promise<void>;
  onCancel: () => void;
  error: { message: string; code?: string } | null;
}) {
  const failure = error ? failureCopy('authenticating', error) : null;
  const ids = { baseUrl: useId(), email: useId(), password: useId() };
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await start({ baseUrl: baseUrl.trim(), email: email.trim(), password });
    } finally {
      setPassword('');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-ink-secondary">
        Enter your Weltbon address and sign in to bring your universe onto this app.
      </p>

      <div>
        <label htmlFor={ids.baseUrl} className="block text-sm text-ink-secondary">
          Address
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
      </div>

      <div>
        <label htmlFor={ids.email} className="block text-sm text-ink-secondary">
          Email
        </label>
        <Input
          id={ids.email}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1"
        />
      </div>

      <div>
        <label htmlFor={ids.password} className="block text-sm text-ink-secondary">
          Password
        </label>
        <Input
          id={ids.password}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1"
        />
      </div>

      {failure && (
        <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
          <p className="font-medium">{failure.headline}</p>
          <p className="mt-1">{failure.message}</p>
          {retry && (
            <Button type="button" variant="ghost" className="mt-2" onClick={() => retry()}>
              Try again
            </Button>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Connecting…' : 'Connect'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

interface PickerUniverse {
  id: string;
  name: string;
  description?: string;
  updatedAt?: string;
  localState?: 'absent' | 'present' | 'linked';
}

function PickerPane({
  universes,
  chooseUniverse,
  onCancel,
}: {
  universes: PickerUniverse[];
  chooseUniverse: (universeId: string) => Promise<void>;
  onCancel: () => void;
}) {
  // length-of-one list auto-skips it), and "choose one" over an empty list is
  if (universes.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          You're signed in, but there are no universes on that Weltbon yet. Create one there
          first, then connect again to bring it onto this app.
        </p>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-secondary">Choose the universe to bring onto this app.</p>
      <ul className="space-y-1">
        {universes.map((u) => {
          const alreadyHere = u.localState === 'present';
          return (
            <li key={u.id}>
              <button
                type="button"
                disabled={alreadyHere}
                onClick={() => chooseUniverse(u.id)}
                className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-glass-border bg-white/5 px-3 py-2 text-left text-sm text-ink hover:enabled:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span>{u.name}</span>
                {u.updatedAt && (
                  <span className="text-xs text-ink-muted">
                    updated {formatRelative(u.updatedAt)}
                  </span>
                )}
              </button>
              {alreadyHere && (
                <p className="mt-1 text-xs text-ink-muted">
                  You already have a copy of this world on this device. Open Settings &rsaquo; Sync to
                  connect it.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function ProgressPane({
  step,
  failedStep,
  error,
  retry,
  onCancel,
}: {
  step: ConnectStep;
  failedStep: ConnectStep | null;
  error: { message: string; code?: string } | null;
  retry?: () => Promise<void>;
  onCancel: () => void;
}) {
  if (failedStep) {
    const failure = failureCopy(failedStep, error);
    return (
      <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
        <p className="font-medium">{failure.headline}</p>
        <p className="mt-1">{failure.message}</p>
        <div className="mt-2 flex gap-2">
          {retry && (
            <Button type="button" variant="ghost" onClick={() => retry()}>
              Try again
            </Button>
          )}
          {/* A FAILED state must never be a one-way door, even though a step
              genuinely in flight (no failedStep yet) offers no Cancel — there
              is no abort semantics for work already dispatched to the server. */}
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return <Loading label={STEP_LABEL[step] ?? 'Working…'} />;
}
