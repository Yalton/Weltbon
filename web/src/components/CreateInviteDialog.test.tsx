import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { CreateInviteDialog } from './CreateInviteDialog';

// Mock the api client (useCreateInvite relies on it)
vi.mock('../api/client', () => ({
  api: vi.fn(),
}));

import { api } from '../api/client';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: new MutationCache({
      onError: () => {
        /* suppress unhandled rejection noise in tests */
      },
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
      <CreateInviteDialog open={open} onOpenChange={setOpen} />
    </Wrapper>
  );
}

const mockInviteWithPlaintext = {
  id: 'inv-99',
  label: "Alice's onboarding",
  bodySuffix: 'XYZ',
  createdAt: new Date().toISOString(),
  plaintext: 'wbn_inv_FAKE_BASE64URL_BODY_43_CHARS_PADDING_XYZ',
};

describe('CreateInviteDialog', () => {
  function installClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
  }

  beforeEach(() => {
    vi.mocked(api).mockReset();
    // Default success for clipboard.writeText; individual tests override.
    installClipboard(vi.fn().mockResolvedValue(undefined));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('form phase', () => {
    // Test 1
    it('renders form phase by default with title "Create an invite code"', () => {
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);
      expect(screen.getByRole('heading', { name: 'Create an invite code' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create invite code' })).toBeInTheDocument();
    });

    // Test 2
    it('renders the UI-SPEC §8.1 form description verbatim', () => {
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);
      expect(
        screen.getByText(
          'Invite codes let you onboard one new user. Give it a label so you remember who you shared it with.',
        ),
      ).toBeInTheDocument();
    });

    // Test 3
    it('label input has autoFocus, maxLength=100, placeholder "e.g. Alice\'s onboarding"', () => {
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);
      const input = screen.getByLabelText('Label') as HTMLInputElement;
      expect(input.placeholder).toBe("e.g. Alice's onboarding");
      expect(input.maxLength).toBe(100);
      // autoFocus is reflected via the active element after mount
      expect(document.activeElement).toBe(input);
    });

    // Test 4
    it('shows "Label is required" on empty submit and does NOT call api()', async () => {
      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);

      const submitBtn = screen.getByRole('button', { name: 'Create invite code' });
      await userEvent.click(submitBtn);

      await waitFor(() => {
        expect(screen.getByText('Label is required')).toBeInTheDocument();
      });
      expect(api).not.toHaveBeenCalled();
    });

    // Test 5
    it('shows "Maximum 100 characters" error for label > 100 chars', async () => {
      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);

      const input = screen.getByLabelText('Label') as HTMLInputElement;
      // Bypass the DOM maxLength attribute so we can simulate >100 chars
      input.removeAttribute('maxlength');
      fireEvent.change(input, { target: { value: 'a'.repeat(101) } });

      await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));

      await waitFor(() => {
        expect(screen.getByText('Maximum 100 characters')).toBeInTheDocument();
      });
      expect(api).not.toHaveBeenCalled();
    });

    // Test 15 (kept in form group for locality)
    it('while mutation pending, Submit button is "Creating…" and disabled', async () => {
      let resolveFn: (v: unknown) => void = () => {};
      vi.mocked(api).mockReturnValue(
        new Promise((r) => {
          resolveFn = r;
        }),
      );

      const qc = makeClient();
      render(<DialogHarness qc={qc} />);

      await userEvent.type(screen.getByLabelText('Label'), "Alice's onboarding");
      await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Creating…' });
        expect(btn).toBeInTheDocument();
        expect(btn).toBeDisabled();
      });

      // Resolve so the promise doesn't dangle past test end
      act(() => {
        resolveFn(mockInviteWithPlaintext);
      });
    });
  });

  describe('mutation transition', () => {
    // Test 6
    it('submitting valid label calls api() with POST + body containing the label', async () => {
      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);

      await userEvent.type(screen.getByLabelText('Label'), "Alice's onboarding");
      await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));

      await waitFor(() => {
        expect(api).toHaveBeenCalledWith(
          '/auth/invites',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ label: "Alice's onboarding" }),
          }),
        );
      });
    });

    // Test 7
    it('after successful mutation, dialog transitions to reveal phase with new title', async () => {
      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);

      await userEvent.type(screen.getByLabelText('Label'), "Alice's onboarding");
      await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Save this invite code now' })).toBeInTheDocument();
      });
    });
  });

  describe('reveal phase', () => {
    async function gotoReveal() {
      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);
      await userEvent.type(screen.getByLabelText('Label'), "Alice's onboarding");
      await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Save this invite code now' })).toBeInTheDocument();
      });
    }

    // Test 8
    it('reveal-phase warning copy contains "This is the only time you\'ll see this code" verbatim', async () => {
      await gotoReveal();
      expect(
        screen.getByText(/This is the only time you'll see this code\. Copy it and send it to the person you want to invite/),
      ).toBeInTheDocument();
    });

    // Test 9
    it('reveal phase displays plaintext inside <code aria-label="Your new invite code">', async () => {
      await gotoReveal();
      const codeEl = screen.getByLabelText('Your new invite code');
      expect(codeEl.tagName).toBe('CODE');
      expect(codeEl.textContent).toBe(mockInviteWithPlaintext.plaintext);
    });
  });

  describe('copy flow', () => {
    async function gotoReveal() {
      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);
      await userEvent.type(screen.getByLabelText('Label'), "Alice's onboarding");
      await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copy invite code' })).toBeInTheDocument();
      });
    }

    // Test 10
    it('clicking Copy writes plaintext to clipboard and flips label to "Copied!" for ~1500ms', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
      const clipboardMock = vi.fn().mockResolvedValue(undefined);
      installClipboard(clipboardMock);

      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const qc = makeClient();
      render(<DialogHarness qc={qc} />);
      await user.type(screen.getByLabelText('Label'), "Alice's onboarding");
      await user.click(screen.getByRole('button', { name: 'Create invite code' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copy invite code' })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'Copy invite code' }));

      expect(clipboardMock).toHaveBeenCalledWith(mockInviteWithPlaintext.plaintext);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
      });

      act(() => {
        vi.advanceTimersByTime(1600);
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copy invite code' })).toBeInTheDocument();
      });
    });

    // Test 11
    it('while copied=true, the aria-live region renders "Invite code copied to clipboard"', async () => {
      await gotoReveal();
      await userEvent.click(screen.getByRole('button', { name: 'Copy invite code' }));
      await waitFor(() => {
        expect(screen.getByText('Invite code copied to clipboard')).toBeInTheDocument();
      });
    });

    // Test 12
    it('if clipboard.writeText rejects, renders the fallback error paragraph', async () => {
      const clipboardMock = vi.fn().mockRejectedValue(new Error('denied'));
      installClipboard(clipboardMock);

      await gotoReveal();
      await userEvent.click(screen.getByRole('button', { name: 'Copy invite code' }));

      await waitFor(() => {
        expect(
          screen.getByText("Couldn't copy. Select the code above and copy manually."),
        ).toBeInTheDocument();
      });
    });
  });

  describe('lifecycle', () => {
    // Test 13
    it('clicking Done calls onOpenChange(false)', async () => {
      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const onOpenChange = vi.fn();
      const qc = makeClient();

      render(
        <Wrapper qc={qc}>
          <CreateInviteDialog open={true} onOpenChange={onOpenChange} />
        </Wrapper>,
      );

      await userEvent.type(screen.getByLabelText('Label'), "Alice's onboarding");
      await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: 'Done' }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    // Test 14
    it('re-opening (open=false → open=true) resets to form phase with empty input', async () => {
      vi.mocked(api).mockResolvedValue(mockInviteWithPlaintext);
      const qc = makeClient();

      function ReopenHarness() {
        const [open, setOpen] = useState(true);
        return (
          <Wrapper qc={qc}>
            <button type="button" onClick={() => setOpen(true)} data-testid="reopen">
              Reopen
            </button>
            <CreateInviteDialog open={open} onOpenChange={setOpen} />
          </Wrapper>
        );
      }

      render(<ReopenHarness />);

      // Drive to reveal phase
      await userEvent.type(screen.getByLabelText('Label'), "Alice's onboarding");
      await userEvent.click(screen.getByRole('button', { name: 'Create invite code' }));
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Save this invite code now' })).toBeInTheDocument();
      });

      // Close via Done
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));

      // Reopen
      await userEvent.click(screen.getByTestId('reopen'));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Create an invite code' })).toBeInTheDocument();
      });
      const input = screen.getByLabelText('Label') as HTMLInputElement;
      expect(input.value).toBe('');
    });
  });
});
