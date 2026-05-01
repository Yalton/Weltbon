import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { CreateTokenDialog } from './CreateTokenDialog';

// Mock the api client (useCreateToken relies on it)
vi.mock('../api/client', () => ({
  api: vi.fn(),
}));

import { api } from '../api/client';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: new MutationCache({
      onError: () => { /* suppress unhandled rejection noise in tests */ },
    }),
  });
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

/** Harness that exposes the dialog with a controllable open prop */
function DialogHarness({ qc }: { qc: QueryClient }) {
  const [open, setOpen] = useState(true);
  return (
    <Wrapper qc={qc}>
      <CreateTokenDialog open={open} onOpenChange={setOpen} />
    </Wrapper>
  );
}

const mockTokenResponse = {
  id: 'tok-1',
  label: 'my script',
  bodySuffix: 'XYZ',
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
  plaintext: 'wbn_pat_AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKKLLLMMMNNN',
};

describe('CreateTokenDialog', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  // Test 1: Form phase renders with correct title and buttons
  it('renders form phase by default with correct title and buttons', () => {
    const qc = makeClient();
    render(<DialogHarness qc={qc} />);

    expect(screen.getByRole('heading', { name: 'Create a personal access token' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeInTheDocument();
  });

  // Test 2: Submitting empty label shows "Label is required" error; mutation NOT called
  it('shows "Label is required" error on empty submit and does not call mutation', async () => {
    vi.mocked(api).mockResolvedValue(mockTokenResponse);
    const qc = makeClient();
    render(<DialogHarness qc={qc} />);

    const submitBtn = screen.getByRole('button', { name: 'Create token' });
    await userEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Label is required')).toBeInTheDocument();
    });
    expect(api).not.toHaveBeenCalled();
  });

  // Test 3: Submitting "  hi  " trims to "hi"; mutation called with label "hi"
  it('trims whitespace and calls mutation with trimmed label', async () => {
    vi.mocked(api).mockResolvedValue(mockTokenResponse);
    const qc = makeClient();
    render(<DialogHarness qc={qc} />);

    const input = screen.getByLabelText('Label');
    await userEvent.type(input, '  hi  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/auth/tokens',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ label: 'hi' }),
        }),
      );
    });
  });

  // Test 4: The Zod schema enforces max 100 characters.
  // Since maxLength={100} on the input prevents typing beyond 100 chars in userEvent,
  // we verify the schema validation by temporarily removing the maxLength attribute and
  // using fireEvent to set the value directly.
  it('shows "Maximum 100 characters" error for label > 100 chars', async () => {
    vi.mocked(api).mockResolvedValue(mockTokenResponse);
    const qc = makeClient();
    render(<DialogHarness qc={qc} />);

    const input = screen.getByLabelText('Label') as HTMLInputElement;

    // Remove maxLength so we can simulate > 100 chars
    input.removeAttribute('maxlength');

    // Use fireEvent to set a value that bypasses userEvent's maxLength check
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input, { target: { value: 'a'.repeat(101) } });

    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      expect(screen.getByText('Maximum 100 characters')).toBeInTheDocument();
    });
    expect(api).not.toHaveBeenCalled();
  });

  // Test 5: After successful mutation, dialog title flips to "Save this token now" and plaintext in <code>
  it('transitions to reveal phase after successful mutation', async () => {
    vi.mocked(api).mockResolvedValue(mockTokenResponse);
    const qc = makeClient();
    render(<DialogHarness qc={qc} />);

    const input = screen.getByLabelText('Label');
    await userEvent.type(input, 'my script');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Save this token now' })).toBeInTheDocument();
    });
    expect(screen.getByText(mockTokenResponse.plaintext)).toBeInTheDocument();
  });

  // Test 6: Click Copy writes to clipboard and button label flips to "Copied!"
  it('clicking Copy writes to clipboard and shows "Copied!" label', async () => {
    vi.mocked(api).mockResolvedValue(mockTokenResponse);
    const clipboardMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: clipboardMock },
    });

    const qc = makeClient();
    render(<DialogHarness qc={qc} />);

    // Navigate to reveal phase
    const input = screen.getByLabelText('Label');
    await userEvent.type(input, 'my script');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy token' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Copy token' }));

    expect(clipboardMock).toHaveBeenCalledWith(mockTokenResponse.plaintext);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    });
  });

  // Test 7: Click Done calls onOpenChange(false)
  it('clicking Done calls onOpenChange(false)', async () => {
    vi.mocked(api).mockResolvedValue(mockTokenResponse);
    const onOpenChange = vi.fn();
    const qc = makeClient();

    render(
      <Wrapper qc={qc}>
        <CreateTokenDialog open={true} onOpenChange={onOpenChange} />
      </Wrapper>
    );

    // Navigate to reveal phase
    const input = screen.getByLabelText('Label');
    await userEvent.type(input, 'my script');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // Test 8: While mutation pending, submit button shows "Creating…" and is disabled
  it('shows "Creating…" and disables submit while mutation is pending', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    vi.mocked(api).mockReturnValue(new Promise((r) => { resolveFn = r; }));

    const qc = makeClient();
    render(<DialogHarness qc={qc} />);

    const input = screen.getByLabelText('Label');
    await userEvent.type(input, 'my script');

    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Creating…' });
      expect(btn).toBeInTheDocument();
      expect(btn).toBeDisabled();
    });

    // Resolve to avoid hanging
    act(() => { resolveFn(mockTokenResponse); });
  });

  // Test 9: Open → close → reopen shows form phase (state reset)
  it('resets to form phase after close and reopen', async () => {
    vi.mocked(api).mockResolvedValue(mockTokenResponse);
    const qc = makeClient();

    function ReopenHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Wrapper qc={qc}>
          <button type="button" onClick={() => setOpen(true)} data-testid="reopen">
            Reopen
          </button>
          <CreateTokenDialog open={open} onOpenChange={setOpen} />
        </Wrapper>
      );
    }

    render(<ReopenHarness />);

    // Navigate to reveal phase
    const input = screen.getByLabelText('Label');
    await userEvent.type(input, 'my script');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Save this token now' })).toBeInTheDocument();
    });

    // Close via Done
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    // Reopen
    await userEvent.click(screen.getByTestId('reopen'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Create a personal access token' })).toBeInTheDocument();
    });
  });
});
