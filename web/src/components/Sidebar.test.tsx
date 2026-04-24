import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the api client so useCategories doesn't actually hit the network.
vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { Sidebar } from './Sidebar';

function renderSidebar(universeId = 'U1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/${universeId}/entries`]}>
        <Sidebar universeId={universeId} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('renders the three top-level nav links with correct hrefs', async () => {
    vi.mocked(api).mockResolvedValue({ categories: [], uncategorizedCount: 0 });

    renderSidebar('UA');

    const entriesLink = await screen.findByRole('link', { name: /entries/i });
    const graphLink = screen.getByRole('link', { name: /graph/i });
    const issuesLink = screen.getByRole('link', { name: /issues/i });

    expect(entriesLink).toHaveAttribute('href', '/universes/UA/entries');
    expect(graphLink).toHaveAttribute('href', '/universes/UA/graph');
    expect(issuesLink).toHaveAttribute('href', '/universes/UA/issues');
  });

  it('renders categories with counts when useCategories returns data', async () => {
    vi.mocked(api).mockResolvedValue({
      categories: [
        { id: 'c1', label: 'Characters', icon: '🧝', sortOrder: 0, entryCount: 12 },
        { id: 'c2', label: 'Places', icon: '🗺', sortOrder: 1, entryCount: 4 },
      ],
      uncategorizedCount: 3,
    });

    renderSidebar();

    expect(await screen.findByText('Characters')).toBeInTheDocument();
    expect(screen.getByText('Places')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('renders the Uncategorized row with its count', async () => {
    vi.mocked(api).mockResolvedValue({
      categories: [],
      uncategorizedCount: 7,
    });

    renderSidebar();

    expect(await screen.findByText(/uncategorized/i)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('always renders the Uncategorized row even when the universe has no categories and zero uncategorized', async () => {
    vi.mocked(api).mockResolvedValue({ categories: [], uncategorizedCount: 0 });

    renderSidebar();

    expect(await screen.findByText(/uncategorized/i)).toBeInTheDocument();
  });

  it('toggles the category collapse state when a category row is clicked', async () => {
    vi.mocked(api).mockResolvedValue({
      categories: [
        { id: 'c1', label: 'Characters', icon: '🧝', sortOrder: 0, entryCount: 12 },
      ],
      uncategorizedCount: 0,
    });

    renderSidebar();

    const button = await screen.findByRole('button', { name: /characters/i });
    expect(button).toHaveAttribute('data-collapsed', 'false');

    await userEvent.click(button);

    await waitFor(() => {
      expect(button).toHaveAttribute('data-collapsed', 'true');
    });

    await userEvent.click(button);

    await waitFor(() => {
      expect(button).toHaveAttribute('data-collapsed', 'false');
    });
  });

  it('renders a loading state while the category query is pending', async () => {
    let resolveFn: (value: unknown) => void = () => {};
    vi.mocked(api).mockReturnValue(new Promise((res) => { resolveFn = res; }));

    renderSidebar();

    expect(await screen.findByText(/loading/i)).toBeInTheDocument();

    // clean up so the pending promise doesn't leak between tests
    resolveFn({ categories: [], uncategorizedCount: 0 });
  });

  it('renders an error state when the category query fails', async () => {
    vi.mocked(api).mockRejectedValue(new Error('boom'));

    renderSidebar();

    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });
});
