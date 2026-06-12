import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
  getAccessToken: () => null,
}));
import { api } from '../api/client';
import { StatsView } from './StatsView';
import type { Stats } from '../hooks/useStats';

const mockStats: Stats = {
  totalEntries: 42,
  totalLinks: 17,
  totalTimelinePins: 5,
  totalCategories: 3,
  entriesByType: [
    { type: 'character', count: 20 },
    { type: 'location', count: 15 },
    { type: 'event', count: 7 },
  ],
  categoryDistribution: [
    { categoryId: 'cat1', label: 'Heroes', count: 25 },
    { categoryId: null, label: 'Uncategorized', count: 17 },
  ],
  recentlyEdited: [
    { id: 'e1', title: 'Aragorn', entryType: 'character', icon: '🧙', updatedAt: '2026-06-01T12:00:00Z' },
    { id: 'e2', title: 'Gandalf', entryType: 'character', icon: null, updatedAt: '2026-06-02T10:00:00Z' },
    { id: 'e3', title: 'Rivendell', entryType: 'location', icon: null, updatedAt: '2026-06-03T08:00:00Z' },
    { id: 'e4', title: 'The Shire', entryType: 'location', icon: null, updatedAt: '2026-06-04T06:00:00Z' },
    { id: 'e5', title: 'Battle of Helm', entryType: 'event', icon: null, updatedAt: '2026-06-05T04:00:00Z' },
    { id: 'e6', title: 'Saruman', entryType: 'character', icon: null, updatedAt: '2026-06-06T02:00:00Z' },
    { id: 'e7', title: 'Sauron', entryType: 'character', icon: null, updatedAt: '2026-06-07T00:00:00Z' },
    { id: 'e8', title: 'Minas Tirith', entryType: 'location', icon: null, updatedAt: '2026-06-08T00:00:00Z' },
    { id: 'e9', title: 'Orthanc', entryType: 'location', icon: null, updatedAt: '2026-06-09T00:00:00Z' },
    { id: 'e10', title: 'One Ring', entryType: 'artifact', icon: null, updatedAt: '2026-06-10T00:00:00Z' },
    { id: 'e11', title: 'Eleventh Entry', entryType: 'character', icon: null, updatedAt: '2026-06-11T00:00:00Z' },
  ],
};

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

function renderAt(path: string, statsData?: Stats | null) {
  vi.mocked(api).mockImplementation(async (url?: string) => {
    if (url?.includes('/stats')) {
      if (statsData === null) {
        throw new Error('Failed to fetch');
      }
      return statsData ?? mockStats;
    }
    return undefined;
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/universes/:uid/stats" element={<StatsView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StatsView', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    navigateMock.mockReset();
  });

  it('renders four stat cards with their counts', async () => {
    renderAt('/universes/U1/stats');

    // Page heading
    expect(await screen.findByRole('heading', { name: /universe overview/i, level: 1 })).toBeInTheDocument();

    // Four stat cards (articles)
    expect(await screen.findByText('Entries')).toBeInTheDocument();
    expect(screen.getByText('Links')).toBeInTheDocument();
    expect(screen.getByText('Pinned events')).toBeInTheDocument();
    expect(screen.getByText('Categories')).toBeInTheDocument();

    // Counts: use getAllByText for values that may appear multiple times
    expect(await screen.findByText('42')).toBeInTheDocument();
    // Links=17 also appears in uncategorized count; just verify at least one exists
    expect(screen.getAllByText('17').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('5')).toBeInTheDocument();
    // Categories=3 also appears in the bar count for event; use getAllByText
    expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
  });

  it('renders a "By type" distribution bar row for each entriesByType item', async () => {
    renderAt('/universes/U1/stats');

    expect(await screen.findByText('By type')).toBeInTheDocument();
    expect(await screen.findByText('character')).toBeInTheDocument();
    expect(screen.getByText('location')).toBeInTheDocument();
    expect(screen.getByText('event')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('navigates to entry list with ?category= when a category bar row is clicked', async () => {
    renderAt('/universes/U1/stats');

    // Wait for data to render (use findByRole to await button)
    const heroesRow = await screen.findByRole('button', { name: /heroes/i });
    fireEvent.click(heroesRow);

    expect(navigateMock).toHaveBeenCalledWith(
      expect.stringContaining('category=cat1'),
    );
  });

  it('navigates to entry list with ?type= when a type bar row is clicked', async () => {
    renderAt('/universes/U1/stats');

    // Wait for data to render
    const characterRow = await screen.findByRole('button', { name: /character/i });
    fireEvent.click(characterRow);

    expect(navigateMock).toHaveBeenCalledWith(
      expect.stringContaining('type=character'),
    );
  });

  it('renders recently-edited list with at most 10 rows', async () => {
    renderAt('/universes/U1/stats');

    expect(await screen.findByText('Recently edited')).toBeInTheDocument();

    // mockStats.recentlyEdited has 11 items, but only 10 should render
    const recentList = await screen.findByRole('list', { name: /recently edited entries/i });
    const items = recentList.querySelectorAll('li');
    expect(items.length).toBeLessThanOrEqual(10);

    // First entry should be visible
    expect(await screen.findByText('Aragorn')).toBeInTheDocument();
    // Eleventh entry should NOT be visible
    expect(screen.queryByText('Eleventh Entry')).not.toBeInTheDocument();
  });

  it('navigates to entry detail when a recently-edited row is clicked', async () => {
    renderAt('/universes/U1/stats');

    // Wait for the button to appear
    const aragornRow = await screen.findByRole('button', { name: /aragorn/i });
    fireEvent.click(aragornRow);

    expect(navigateMock).toHaveBeenCalledWith(
      expect.stringContaining('/entries/e1'),
    );
  });

  it('renders error state when stats fetch fails', async () => {
    renderAt('/universes/U1/stats', null);

    expect(await screen.findByText("Couldn't load stats. Refresh to try again.")).toBeInTheDocument();
  });
});
