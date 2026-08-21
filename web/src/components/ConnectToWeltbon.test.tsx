/**
 * REAL SERVER STRINGS ONLY (fix wave, I4).
 *
 * Every `error` fixture below is a message + code this API can actually
 * produce, copied verbatim from the throw site named beside it. An earlier
 * revision of this file invented friendly-sounding text ("That instance
 * stopped responding while bringing in your content") that exists nowhere in
 * the repo, which made the copy-rule test vacuous: it proved the component
 * does not print banned words when handed text that already contains none.
 * The words this feature must never show are in the SERVER's strings, so those
 * are what these fixtures carry.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectToWeltbon } from './ConnectToWeltbon';

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../hooks/useConnectToWeltbon', () => ({
  useConnectToWeltbon: () => state.current,
}));

/**
 * The messages the four connect calls really throw, with the code that rides
 * alongside each on the wire. Sources:
 *   api/src/services/sync/peer-auth.ts   (peer_* codes)
 *   api/src/services/sync/remote-url.ts  (InvalidRemoteUrlError)
 *   api/src/services/sync/run-errors.ts  (every SyncRunError subclass)
 *   api/src/routes/sync-client.ts        (encryptionUnavailable(), 503, no code)
 */
const SERVER_ERRORS = {
  // peer-auth.ts:112 — the wrong-password case, the one a user hits most.
  badCredentials: {
    message: 'that instance did not accept the email and password',
    code: 'peer_credentials_rejected',
  },
  // remote-url.ts:24 + :90 — an address typed with no scheme, the common typo.
  noScheme: {
    message: 'Invalid remote URL: not a valid absolute URL',
    code: 'invalid-remote-url',
  },
  // remote-url.ts:24 + :96 — https://user:pw@host.
  urlCredentials: {
    message: 'Invalid remote URL: credentials in the URL are not allowed — the PAT travels in a header',
    code: 'invalid-remote-url',
  },
  // peer-auth.ts:97 — nothing answered at that address.
  unreachable: {
    message: 'could not reach a Weltbon instance at that address',
    code: 'peer_unreachable',
  },
  // run-errors.ts:129 — the user pointed the desktop at itself.
  selfConnect: {
    message: 'This remote resolves to this Weltbon instance and cannot be linked or synced',
    code: 'SELF_REMOTE',
  },
  // run-errors.ts:194 — adopt against a universe the peer no longer offers.
  notOnPeer: {
    message: 'That universe is not on the remote instance',
    code: 'universe-not-on-remote',
  },
  // run-errors.ts:85 — the stored credential was revoked on the peer.
  revoked: {
    message: 'The remote rejected the stored PAT',
    code: 'remote-unauthorized',
  },
  // run-errors.ts:178 — the peer's copy of the universe was deleted.
  universeGone: {
    message: 'The universe no longer exists on the remote — re-link or remove this link',
    code: 'remote-universe-missing',
  },
  // sync-client.ts's encryptionUnavailable() — a 503 with NO code at all, so
  // it exercises the fallback branch. Its text names a "remote", which is
  // exactly why the fallback must not be `error.message`.
  encryptionUnconfigured: {
    message:
      'Server is not configured for sync remote encryption. ' +
      'Operator must set LLM_KEY_ENCRYPTION_KEY (see README ## Self-Host).',
  },
} as const;

const BANNED = /\bremote\b|\blink\b|\btoken\b|\bpat\b/;

describe('ConnectToWeltbon', () => {
  it('collects address and sign-in details and starts the flow', async () => {
    const start = vi.fn();
    state.current = { step: 'idle', failedStep: null, error: null, universes: [], start };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/address/i), 'https://peer.example');
    await userEvent.type(screen.getByLabelText(/email/i), 'me@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(start).toHaveBeenCalledWith({
      baseUrl: 'https://peer.example', email: 'me@example.com', password: 'hunter2',
    });
  });

  it('shows the picker only when the flow is choosing', () => {
    state.current = {
      step: 'choosing', failedStep: null, error: null,
      universes: [{ id: 'u1', name: 'Alpha' }, { id: 'u2', name: 'Beta' }],
      chooseUniverse: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Beta/ })).toBeInTheDocument();
  });

  it('names the failed step on screen, renders user-facing copy, and offers a retry', () => {
    state.current = {
      step: 'authenticating', failedStep: 'authenticating',
      error: SERVER_ERRORS.badCredentials, universes: [], retry: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);

    // The step itself, on screen — the Definition of Done's "every failure
    // names its step". Previously only the Loading path ever showed one.
    expect(screen.getByText(/stopped while signing you in/i)).toBeInTheDocument();
    // The spec's error-table copy, not the server's own sentence.
    expect(screen.getByText(/email or password wasn't accepted by that instance/i)).toBeInTheDocument();
    expect(screen.queryByText(SERVER_ERRORS.badCredentials.message)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('names the step for a failure on the progress pane too', () => {
    state.current = {
      step: 'discovering', failedStep: 'discovering',
      error: SERVER_ERRORS.selfConnect, universes: [], retry: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/stopped while looking for your universes/i)).toBeInTheDocument();
    expect(screen.getByText(/that's this instance — connect to a different one/i)).toBeInTheDocument();
  });

  it('renders the spec error-table copy for a bad address, never the server reason', () => {
    for (const err of [SERVER_ERRORS.noScheme, SERVER_ERRORS.urlCredentials]) {
      state.current = {
        step: 'authenticating', failedStep: 'authenticating', error: err,
        universes: [], retry: vi.fn(),
      };
      const { unmount } = render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.getByText(/that doesn't look like a weltbon address/i)).toBeInTheDocument();
      expect(screen.queryByText(err.message)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('falls back to a step-attributed sentence for an error with no code, not to its text', () => {
    state.current = {
      step: 'authenticating', failedStep: 'authenticating',
      error: SERVER_ERRORS.encryptionUnconfigured, universes: [], retry: vi.fn(),
    };
    const { container } = render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/something went wrong while signing you in/i)).toBeInTheDocument();
    expect(container.textContent).not.toContain('LLM_KEY_ENCRYPTION_KEY');
  });

  it('disables an already-present universe in the picker but explains why, leaving others clickable', async () => {
    const chooseUniverse = vi.fn();
    state.current = {
      step: 'choosing', failedStep: null, error: null,
      universes: [
        { id: 'u1', name: 'Alpha', localState: 'absent' },
        { id: 'u2', name: 'Beta', localState: 'present' },
        { id: 'u3', name: 'Gamma', localState: 'linked' },
      ],
      chooseUniverse,
    };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);

    const betaButton = screen.getByRole('button', { name: /Beta/ });
    expect(betaButton).toBeDisabled();
    expect(screen.getByText(/already have a copy of this world/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    expect(chooseUniverse).toHaveBeenCalledWith('u1');

    chooseUniverse.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /Gamma/ }));
    expect(chooseUniverse).toHaveBeenCalledWith('u3');
  });

  it('explains an account with no universes instead of asking it to choose from nothing', () => {
    // Only a one-item list auto-skips the picker, so a peer account holding
    // zero universes lands here. "Choose the universe" over an empty list is
    // an instruction the user cannot follow.
    state.current = {
      step: 'choosing', failedStep: null, error: null, universes: [], chooseUniverse: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/no universes on that weltbon yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/choose the universe to bring/i)).not.toBeInTheDocument();
  });

  it('lands a mid-flow failure on the progress pane, not the credential form', () => {
    // 'adopting': a failure with no universe to land in, which is what keeps
    // the user in this pane. (A 'syncing' failure WITH a universe navigates
    // instead — see the OB-04 test below.)
    state.current = {
      step: 'adopting', failedStep: 'adopting', universeId: null,
      error: SERVER_ERRORS.notOnPeer, universes: [], retry: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(/stopped while setting up your universe/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/address/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('uses none of the words remote, link, or token in its copy, across every pane', () => {
    const scenarios: Array<Record<string, unknown>> = [
      // Credentials pane, no error.
      { step: 'idle', failedStep: null, error: null, universes: [], start: vi.fn() },
      // Credentials pane, every failure step 1 can produce, with the REAL
      // server text — each of these messages contains a banned word.
      ...[
        SERVER_ERRORS.badCredentials,
        SERVER_ERRORS.noScheme,
        SERVER_ERRORS.urlCredentials,
        SERVER_ERRORS.unreachable,
        SERVER_ERRORS.encryptionUnconfigured,
      ].map((error) => ({
        step: 'authenticating', failedStep: 'authenticating', error,
        universes: [], retry: vi.fn(),
      })),
      // Discovery failures.
      ...[SERVER_ERRORS.selfConnect, SERVER_ERRORS.revoked].map((error) => ({
        step: 'discovering', failedStep: 'discovering', error, universes: [], retry: vi.fn(),
      })),
      // Adopt failure.
      {
        step: 'adopting', failedStep: 'adopting', universeId: null,
        error: SERVER_ERRORS.notOnPeer, universes: [], retry: vi.fn(),
      },
      // First-pull failure with no universe id, so it stays in this pane.
      {
        step: 'syncing', failedStep: 'syncing', universeId: null,
        error: SERVER_ERRORS.universeGone, universes: [], retry: vi.fn(),
      },
      // Picker pane, including a disabled 'present' entry.
      {
        step: 'choosing', failedStep: null, error: null,
        universes: [
          { id: 'u1', name: 'Alpha', localState: 'absent' },
          { id: 'u2', name: 'Beta', localState: 'present' },
          { id: 'u3', name: 'Gamma', localState: 'linked' },
        ],
        chooseUniverse: vi.fn(),
      },
      // Picker pane, empty.
      { step: 'choosing', failedStep: null, error: null, universes: [], chooseUniverse: vi.fn() },
      // Progress pane, mid-flow, no failure.
      { step: 'syncing', failedStep: null, error: null, universes: [], retry: vi.fn() },
    ];

    for (const scenario of scenarios) {
      state.current = scenario;
      const { container, unmount } = render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
      expect(container.textContent!.toLowerCase()).not.toMatch(BANNED);
      unmount();
    }
  });

  // Guards the guard: if a future fixture is softened back to invented text,
  // this fails and says so, instead of the copy-rule test quietly passing on
  // strings the server can never produce.
  it('tests the copy rule against server text that really does contain the banned words', () => {
    const withBannedWords = Object.values(SERVER_ERRORS).filter((e) =>
      BANNED.test(e.message.toLowerCase()),
    );
    expect(withBannedWords.length).toBeGreaterThanOrEqual(6);
  });

  it('calls onDone once the flow finishes', async () => {
    const onDone = vi.fn();
    state.current = { step: 'done', failedStep: null, error: null, universes: [], universeId: 'u1' };
    render(<ConnectToWeltbon onDone={onDone} onCancel={vi.fn()} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('u1'));
  });

  it('sends the user into the adopted universe when only the first sync failed (OB-04)', async () => {
    // The spec: "The user lands in it with a persistent 'first sync didn't
    // finish — Retry' banner rather than being bounced back to a form." That
    // banner is on EntryList and is driven by persisted link state; nothing
    // reaches it unless this component navigates. Cancelling here would
    // instead unmount the hook and throw the universe id away.
    const onDone = vi.fn();
    state.current = {
      step: 'syncing', failedStep: 'syncing', universeId: 'u1', linkId: 'link-1',
      error: SERVER_ERRORS.universeGone, universes: [], retry: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={onDone} onCancel={vi.fn()} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('u1'));
  });

  it('does NOT navigate for a failure at a step that adopted no universe', async () => {
    const onDone = vi.fn();
    state.current = {
      step: 'adopting', failedStep: 'adopting', universeId: null,
      error: SERVER_ERRORS.notOnPeer, universes: [], retry: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={onDone} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(onDone).not.toHaveBeenCalled();
  });
});
