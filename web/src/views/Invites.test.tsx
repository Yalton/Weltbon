import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Mock the api client at the module level so no real network call ever happens.
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: vi.fn(),
}));


// Stubbing it here keeps this test file (and module resolution) green pre-merge,
// and the real component takes over once the wave lands — the stub renders nothing
// because the dialog is a sibling concern; the revoke + list behavior under test
// is independent of the create flow.
vi.mock('../components/CreateInviteDialog', () => ({
  CreateInviteDialog: () => null,
}));

const runtime = { authMode: 'server' as 'server' | 'local' };
vi.mock('../runtime/RuntimeProvider', () => ({
  useRuntime: () => runtime,
}));

import { api, ApiError } from '../api/client';
import { useAuthStore } from '../store/auth';
import Invites from './Invites';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/invites']}>
        <Routes>
          <Route path="/settings/invites" element={<>{children}</>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Three-day-old fixture mirrors UI-SPEC §13 example copy
const baseInvite = {
  id: 'inv-1',
  label: "Alice's onboarding",
  bodySuffix: 'XYZ',
  createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  usedAt: null as string | null,
  revokedAt: null as string | null,
  usedBy: null as { displayName: string; email: string } | null,
};

const activeInvite = { ...baseInvite };
const usedInvite = {
  ...baseInvite,
  id: 'inv-2',
  usedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  usedBy: { displayName: 'Bob Smith', email: 'bob@example.com' },
};
const usedInviteNoDisplayName = {
  ...baseInvite,
  id: 'inv-3',
  usedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  usedBy: { displayName: '', email: 'noname@example.com' },
};
const revokedInvite = {
  ...baseInvite,
  id: 'inv-4',
  revokedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
  // even though usedBy is non-null, status takes precedence and the cell stays empty
  usedBy: { displayName: 'Bob Smith', email: 'bob@example.com' },
};

describe('Invites view', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    useAuthStore.setState({ user: null });
    runtime.authMode = 'server';
  });

  // 1. Empty state copy is locked.
  it('renders empty state with locked copy when API returns []', async () => {
    vi.mocked(api).mockResolvedValue([]);
    const qc = makeClient();
    render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByText('No invite codes yet')).toBeInTheDocument();
    });
    expect(
      screen.getByText('Create an invite code to share with someone you want to onboard. Each code can only be used once.')
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New invite code' }).length).toBeGreaterThan(0);
  });

  // 2. Loading skeleton — 3 animate-pulse rows under aria-busy="true"
  it('renders 3 skeleton rows (animate-pulse) while loading', async () => {
    vi.mocked(api).mockReturnValue(new Promise(() => {})); // never-resolves
    const qc = makeClient();
    render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      const pulseElements = document.querySelectorAll('.animate-pulse');
      expect(pulseElements.length).toBe(3);
    });
    expect(screen.getByLabelText('Loading invite codes')).toHaveAttribute('aria-busy', 'true');
  });

  // 3. Populated state — table with masked preview literal
  it('renders table with masked preview format wbn_inv_••••••XYZ when populated', async () => {
    vi.mocked(api).mockResolvedValue([activeInvite]);
    const qc = makeClient();
    render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('invites-table')).toBeInTheDocument();
    });
    expect(screen.getByText('wbn_inv_••••••XYZ')).toBeInTheDocument();
  });

  describe('status chip', () => {
    // 4. Active row → "active" chip
    it('renders "active" chip for an unconsumed, unrevoked invite', async () => {
      vi.mocked(api).mockResolvedValue([activeInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      expect(screen.getByText('active')).toBeInTheDocument();
    });

    // 5. Used row → "used" chip
    it('renders "used" chip for an invite with usedAt set', async () => {
      vi.mocked(api).mockResolvedValue([usedInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      expect(screen.getByText('used')).toBeInTheDocument();
    });

    // 6. Revoked row → "revoked" chip + opacity-50 row + line-through label
    it('renders "revoked" chip and applies opacity-50 + line-through styling', async () => {
      vi.mocked(api).mockResolvedValue([revokedInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      expect(screen.getByText('revoked')).toBeInTheDocument();

      // Find the <tr> for the revoked invite — first <tr> in <tbody>
      const tbody = screen.getByTestId('invites-table').querySelector('tbody');
      expect(tbody).not.toBeNull();
      const row = tbody!.querySelector('tr');
      expect(row).not.toBeNull();
      expect(row!.className).toContain('opacity-50');

      // The label cell (row header) gets line-through
      const labelCell = row!.querySelector('th[scope="row"]');
      expect(labelCell).not.toBeNull();
      expect(labelCell!.className).toContain('line-through');
    });
  });

  describe('used-by cell', () => {
    // 7. displayName when non-empty
    it('shows displayName for a used invite when displayName is non-empty', async () => {
      vi.mocked(api).mockResolvedValue([usedInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      expect(screen.getByText('Bob Smith')).toBeInTheDocument();
    });

    // 8. Italic email fallback when displayName empty
    it('shows italic email for a used invite when displayName is empty', async () => {
      vi.mocked(api).mockResolvedValue([usedInviteNoDisplayName]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      const emailEl = screen.getByText('noname@example.com');
      expect(emailEl).toBeInTheDocument();
      expect(emailEl.className).toContain('italic');
    });

    // 9. Active row → used-by cell empty
    it('renders an empty used-by cell for active rows', async () => {
      vi.mocked(api).mockResolvedValue([activeInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      // No displayName or email text — only the page intro mentions general copy.
      expect(screen.queryByText('Bob Smith')).not.toBeInTheDocument();
      expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
    });

    // 10. Revoked row → used-by cell empty even with usedBy set
    it('renders an empty used-by cell for revoked rows even when usedBy is set', async () => {
      vi.mocked(api).mockResolvedValue([revokedInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      expect(screen.queryByText('Bob Smith')).not.toBeInTheDocument();
      expect(screen.queryByText('bob@example.com')).not.toBeInTheDocument();
    });
  });

  describe('revoke flow', () => {
    // 11. Revoke button absent on used rows
    it('does not show the Revoke button on used rows', async () => {
      vi.mocked(api).mockResolvedValue([usedInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    });

    // 12. Revoke button absent on revoked rows
    it('does not show the Revoke button on revoked rows', async () => {
      vi.mocked(api).mockResolvedValue([revokedInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    });

    // 13. Revoke button on active row → opens ConfirmDialog with locked title + body
    it('clicking Revoke opens ConfirmDialog with title "Revoke invite code" and label-substituted body', async () => {
      vi.mocked(api).mockResolvedValue([activeInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());

      const revokeBtn = screen.getByRole('button', { name: 'Revoke' });
      await userEvent.click(revokeBtn);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Revoke invite code' })).toBeInTheDocument();
      });
      expect(screen.getByText(/Revoking "Alice's onboarding" makes it immediately invalid/)).toBeInTheDocument();
    });

    // 14. Cancel closes the dialog without firing DELETE
    it('clicking Cancel closes the ConfirmDialog without calling DELETE', async () => {
      vi.mocked(api).mockResolvedValue([activeInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());

      const revokeBtn = screen.getByRole('button', { name: 'Revoke' });
      await userEvent.click(revokeBtn);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Revoke invite code' })).toBeInTheDocument();
      });

      const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
      await userEvent.click(cancelBtn);

      await waitFor(() => {
        expect(screen.queryByRole('heading', { name: 'Revoke invite code' })).not.toBeInTheDocument();
      });

      // api was called once for the GET; never with method=DELETE
      const deleteCalls = vi.mocked(api).mock.calls.filter(
        ([_, init]) => init && (init as RequestInit).method === 'DELETE'
      );
      expect(deleteCalls.length).toBe(0);
    });

    // 15. Confirm fires DELETE /auth/invites/:id
    it('clicking "Revoke code" calls DELETE /auth/invites/:id', async () => {
      vi.mocked(api).mockResolvedValue([activeInvite]);
      const qc = makeClient();
      render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

      await waitFor(() => expect(screen.getByTestId('invites-table')).toBeInTheDocument());

      const revokeBtn = screen.getByRole('button', { name: 'Revoke' });
      await userEvent.click(revokeBtn);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Revoke invite code' })).toBeInTheDocument();
      });

      // Stage a void resolution for the DELETE call.
      vi.mocked(api).mockResolvedValueOnce(undefined as unknown as never);

      const confirmBtn = screen.getByRole('button', { name: 'Revoke code' });
      await userEvent.click(confirmBtn);

      await waitFor(() => {
        expect(api).toHaveBeenCalledWith(
          '/auth/invites/inv-1',
          expect.objectContaining({ method: 'DELETE' })
        );
      });
    });
  });

  // 16. Locked intro copy is rendered verbatim
  it('renders the locked intro copy "Treat codes like passwords"', async () => {
    vi.mocked(api).mockResolvedValue([]);
    const qc = makeClient();
    render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByText(/Treat codes like passwords/)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Invite requests review (admin, server mode)
// ---------------------------------------------------------------------------

const adminUser = { id: 'admin-1', email: 'admin@test.dev', displayName: 'Admin', isAdmin: true };

const pendingRequest = {
  id: 'req-1',
  name: 'Carol Jones',
  email: 'carol@example.com',
  note: 'I run a worldbuilding club',
  status: 'pending' as const,
  createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  reviewedAt: null,
  reviewedBy: null,
  inviteCodeId: null,
};

function renderInvites() {
  const qc = makeClient();
  render(<Invites />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });
}

/** Routes api() calls by path; `requests` is read on every GET so tests can mutate it. */
function mockApi(state: {
  requests: typeof pendingRequest[];
  issue?: () => unknown;
  dismiss?: () => unknown;
}) {
  vi.mocked(api).mockImplementation((async (path: string, init?: RequestInit) => {
    if (path === '/auth/invites') return [];
    if (path === '/admin/invite-requests?status=pending') return state.requests;
    if (path === `/admin/invite-requests/req-1/issue` && init?.method === 'POST') return state.issue!();
    if (path === `/admin/invite-requests/req-1/dismiss` && init?.method === 'POST') return state.dismiss!();
    throw new Error(`unexpected api call ${path}`);
  }) as unknown as typeof api);
}

describe('Invites view — requests section', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    useAuthStore.setState({ user: adminUser });
    runtime.authMode = 'server';
  });

  it('lists pending requests with name, email and note', async () => {
    mockApi({ requests: [pendingRequest] });
    renderInvites();

    expect(await screen.findByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(await screen.findByText('Carol Jones')).toBeInTheDocument();
    expect(screen.getByText('carol@example.com')).toBeInTheDocument();
    expect(screen.getByText('I run a worldbuilding club')).toBeInTheDocument();
    expect(screen.getByText('2 days ago')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/admin/invite-requests?status=pending');
  });

  it('shows "No pending requests" when the list is empty', async () => {
    mockApi({ requests: [] });
    renderInvites();
    expect(await screen.findByText('No pending requests')).toBeInTheDocument();
  });

  it('issuing a code shows the code once with copy and mailto, and refetches both lists', async () => {
    const state = {
      requests: [pendingRequest],
      issue: () => {
        state.requests = [];
        return {
          request: { ...pendingRequest, status: 'issued' },
          invite: { id: 'inv-9', label: 'Carol Jones', bodySuffix: 'ABC', createdAt: new Date().toISOString(), plaintext: 'wbn_inv_secretABC' },
        };
      },
    };
    mockApi(state);
    renderInvites();

    await userEvent.click(await screen.findByRole('button', { name: 'Issue code' }));

    expect(await screen.findByText('wbn_inv_secretABC')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invite code' })).toBeInTheDocument();
    const mail = screen.getByRole('link', { name: /Email carol@example.com/ });
    const href = mail.getAttribute('href')!;
    expect(href.startsWith('mailto:carol@example.com?')).toBe(true);
    expect(decodeURIComponent(href)).toContain('Your Weltbon invitation code');
    expect(decodeURIComponent(href)).toContain('wbn_inv_secretABC');

    expect(api).toHaveBeenCalledWith('/admin/invite-requests/req-1/issue', expect.objectContaining({ method: 'POST' }));
    await waitFor(() => expect(screen.getByText('No pending requests')).toBeInTheDocument());
    const inviteGets = vi.mocked(api).mock.calls.filter(([p]) => p === '/auth/invites');
    expect(inviteGets.length).toBeGreaterThanOrEqual(2);

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('wbn_inv_secretABC')).not.toBeInTheDocument();
  });

  it('dismiss asks for confirmation, then removes the row', async () => {
    const state = {
      requests: [pendingRequest],
      dismiss: () => {
        state.requests = [];
        return { ...pendingRequest, status: 'dismissed' };
      },
    };
    mockApi(state);
    renderInvites();

    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByRole('heading', { name: 'Dismiss invite request' })).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith('/admin/invite-requests/req-1/dismiss', expect.anything());

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss request' }));

    await waitFor(() => expect(screen.queryByText('Carol Jones')).not.toBeInTheDocument());
    expect(screen.getByText('No pending requests')).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith('/admin/invite-requests/req-1/dismiss', expect.objectContaining({ method: 'POST' }));
  });

  it('shows an inline error when issuing fails', async () => {
    mockApi({
      requests: [pendingRequest],
      issue: () => { throw new Error('Request already reviewed'); },
    });
    renderInvites();

    await userEvent.click(await screen.findByRole('button', { name: 'Issue code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Request already reviewed');
  });

  it('explains a 409 (already reviewed) inline', async () => {
    mockApi({
      requests: [pendingRequest],
      issue: () => { throw new ApiError(409, { code: 'not_pending' }, 'Conflict'); },
    });
    renderInvites();

    await userEvent.click(await screen.findByRole('button', { name: 'Issue code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already reviewed');
  });

  it('is hidden for non-admins and makes no request', async () => {
    useAuthStore.setState({ user: { ...adminUser, isAdmin: false } });
    mockApi({ requests: [pendingRequest] });
    renderInvites();

    await waitFor(() => expect(screen.getByText('No invite codes yet')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Requests' })).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith('/admin/invite-requests?status=pending');
  });

  it('is hidden in local auth mode', async () => {
    runtime.authMode = 'local';
    mockApi({ requests: [pendingRequest] });
    renderInvites();

    await waitFor(() => expect(screen.getByText('No invite codes yet')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'Requests' })).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith('/admin/invite-requests?status=pending');
  });
});
