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

  it('uses none of the words remote, link, or token in its copy', () => {
    state.current = { step: 'idle', failedStep: null, error: null, universes: [], start: vi.fn() };
    const { container } = render(<ConnectToWeltbon onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(container.textContent!.toLowerCase()).not.toMatch(/\bremote\b|\blink\b|\btoken\b|\bpat\b/);
  });

  it('calls onDone once the flow finishes', async () => {
    const onDone = vi.fn();
    state.current = { step: 'done', failedStep: null, error: null, universes: [], universeId: 'u1' };
    render(<ConnectToWeltbon onDone={onDone} onCancel={vi.fn()} />);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('u1'));
  });
});
