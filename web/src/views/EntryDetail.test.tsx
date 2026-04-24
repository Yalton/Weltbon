import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
  getAccessToken: () => null,
}));
import { api } from '../api/client';
import { EntryDetail } from './EntryDetail';

function mkEntryDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'E1',
    universeId: 'U1',
    title: 'Gondor',
    entryType: 'location',
    summary: 'A kingdom of men',
    tags: ['kingdom'],
    meta: {},
    icon: '🏰',
    categoryId: null,
    body: '# Realm',
    outboundLinks: [],
    backlinks: [],
    issues: [],
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...overrides,
  };
}

function renderAt(path: string, entry: ReturnType<typeof mkEntryDetail>) {
  vi.mocked(api).mockImplementation(async (p?: string) => {
    if (p === '/universes/U1/entries/E1') return entry;
    return undefined;
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/universes/:uid/entries/:entryId" element={<EntryDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EntryDetail (issues section)', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders the IssueSection with heading and issue rows from entry.issues', async () => {
    renderAt('/universes/U1/entries/E1', mkEntryDetail({
      issues: [
        { id: 'i1', title: 'Name spelled two ways', severity: 'major' },
      ],
    }));

    expect(await screen.findByRole('heading', { name: /issues \(1\)/i })).toBeInTheDocument();
    expect(screen.getByText('Name spelled two ways')).toBeInTheDocument();
  });

  it('renders the empty-state message when entry.issues is empty', async () => {
    renderAt('/universes/U1/entries/E1', mkEntryDetail({ issues: [] }));

    expect(await screen.findByRole('heading', { name: /issues \(0\)/i })).toBeInTheDocument();
    expect(screen.getByText(/no open issues for this entry/i)).toBeInTheDocument();
  });

  it('clicking Flag issue opens the IssueEditor dialog', async () => {
    renderAt('/universes/U1/entries/E1', mkEntryDetail({ issues: [] }));

    await screen.findByRole('heading', { name: /issues \(0\)/i });
    await userEvent.click(screen.getByRole('button', { name: /flag issue/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
