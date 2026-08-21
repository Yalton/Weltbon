import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectToWeltbon } from './ConnectToWeltbon';

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../hooks/useConnectToWeltbon', () => ({
  useConnectToWeltbon: () => state.current,
}));

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

  it('names the failed step and offers a retry', () => {
    state.current = {
      step: 'authenticating', failedStep: 'authenticating',
      error: { message: 'that instance did not accept the email and password', code: 'peer_credentials_rejected' },
      universes: [], retry: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/did not accept the email and password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
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

  it('lands a mid-flow failure on the progress pane, not the credential form', () => {
    state.current = {
      step: 'syncing', failedStep: 'syncing',
      error: { message: 'That instance stopped responding while bringing in your content', code: 'sync-run-failed' },
      universes: [], retry: vi.fn(),
    };
    render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(/stopped responding while bringing in your content/i)).toBeInTheDocument();
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
      // Credentials pane, authenticating failure.
      {
        step: 'authenticating', failedStep: 'authenticating',
        error: { message: 'that instance did not accept the email and password', code: 'peer_credentials_rejected' },
        universes: [], retry: vi.fn(),
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
      // Progress pane, mid-flow, no failure.
      { step: 'syncing', failedStep: null, error: null, universes: [], retry: vi.fn() },
      // Progress pane, with a populated error.
      {
        step: 'syncing', failedStep: 'syncing',
        error: { message: 'That instance stopped responding while bringing in your content', code: 'sync-run-failed' },
        universes: [], retry: vi.fn(),
      },
    ];

    for (const scenario of scenarios) {
      state.current = scenario;
      const { container, unmount } = render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
      expect(container.textContent!.toLowerCase()).not.toMatch(/\bremote\b|\blink\b|\btoken\b|\bpat\b/);
      unmount();
    }
  });

  it('calls onDone once the flow finishes', async () => {
    const onDone = vi.fn();
    state.current = { step: 'done', failedStep: null, error: null, universes: [], universeId: 'u1' };
    render(<ConnectToWeltbon onDone={onDone} onCancel={vi.fn()} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('u1'));
  });
});
