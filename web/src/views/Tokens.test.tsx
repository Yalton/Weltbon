import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));

import { api } from '../api/client';
import Tokens from './Tokens';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/tokens']}>
        <Routes>
          <Route path="/settings/tokens" element={<>{children}</>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const mockToken = {
  id: 'tok-1',
  label: 'backup script',
  bodySuffix: 'XYZ',
  createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  lastUsedAt: null as string | null,
};

describe('Tokens page', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('renders empty state with "No tokens yet" when API returns []', async () => {
    vi.mocked(api).mockResolvedValue([]);
    const qc = makeClient();
    render(<Tokens />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByText('No tokens yet')).toBeInTheDocument();
    });
    expect(screen.getByText('Create a token to authenticate API requests from scripts or other tools.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New token' }).length).toBeGreaterThan(0);
  });

  it('renders 3 skeleton rows (animate-pulse) while loading', async () => {
    // Make api hang indefinitely to keep isPending state
    vi.mocked(api).mockReturnValue(new Promise(() => {}));
    const qc = makeClient();
    render(<Tokens />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      const pulseElements = document.querySelectorAll('.animate-pulse');
      expect(pulseElements.length).toBe(3);
    });
  });

  it('renders table with masked preview format wbn_pat_••••••XYZ when populated', async () => {
    vi.mocked(api).mockResolvedValue([mockToken]);
    const qc = makeClient();
    render(<Tokens />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('tokens-table')).toBeInTheDocument();
    });
    expect(screen.getByText('wbn_pat_••••••XYZ')).toBeInTheDocument();
  });

  it('renders "Never" for null lastUsedAt', async () => {
    vi.mocked(api).mockResolvedValue([{ ...mockToken, lastUsedAt: null }]);
    const qc = makeClient();
    render(<Tokens />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('tokens-table')).toBeInTheDocument();
    });
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('renders "(unnamed)" italic when label is empty string', async () => {
    vi.mocked(api).mockResolvedValue([{ ...mockToken, label: '' }]);
    const qc = makeClient();
    render(<Tokens />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('tokens-table')).toBeInTheDocument();
    });
    expect(screen.getByText('(unnamed)')).toBeInTheDocument();
  });

  it('clicking Revoke opens ConfirmDialog with title "Revoke token" and the token label', async () => {
    vi.mocked(api).mockResolvedValue([mockToken]);
    const qc = makeClient();
    render(<Tokens />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('tokens-table')).toBeInTheDocument();
    });

    const revokeBtn = screen.getByRole('button', { name: 'Revoke' });
    await userEvent.click(revokeBtn);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Revoke token' })).toBeInTheDocument();
    });
    // Body should contain the label (in the confirm dialog body text)
    expect(screen.getByText(/Revoking "backup script"/)).toBeInTheDocument();
  });

  it('cancel button closes the ConfirmDialog', async () => {
    vi.mocked(api).mockResolvedValue([mockToken]);
    const qc = makeClient();
    render(<Tokens />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('tokens-table')).toBeInTheDocument();
    });

    const revokeBtn = screen.getByRole('button', { name: 'Revoke' });
    await userEvent.click(revokeBtn);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Revoke token' })).toBeInTheDocument();
    });

    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    await userEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Revoke token' })).not.toBeInTheDocument();
    });
  });
});
