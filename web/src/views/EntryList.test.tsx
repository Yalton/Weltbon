import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock api client so every network call is dispatched by path.
vi.mock('../api/client', () => ({
  api: vi.fn(),
  getAccessToken: () => null,
}));
import { api } from '../api/client';
import { EntryList } from './EntryList';

function mkEntry(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    universeId: 'U1',
    title,
    entryType: 'character',
    summary: '',
    tags: [],
    meta: {},
    icon: '',
    categoryId: null,
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...overrides,
  };
}

function setupApi({
  universe,
  categories,
  entriesByQuery,
}: {
  universe: { id: string; entryTypes: string[] };
  categories: Array<{ id: string; label: string; icon: string; sortOrder: number; entryCount: number }>;
  entriesByQuery: (path: string) => unknown;
}) {
  vi.mocked(api).mockImplementation(async (path?: string) => {
    if (!path) return undefined;
    if (path === '/universes/U1') return universe;
    if (path === '/universes/U1/categories') return { categories, uncategorizedCount: 0 };
    if (path.startsWith('/universes/U1/entries')) return entriesByQuery(path);
    return undefined;
  });
}

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/universes/:uid/entries" element={<EntryList />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EntryList', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('renders the SearchBar and FilterChipRow above the list', async () => {
    setupApi({
      universe: { id: 'U1', entryTypes: ['character'] },
      categories: [],
      entriesByQuery: () => [mkEntry('e1', 'Alpha')],
    });

    renderAt('/universes/U1/entries');

    expect(await screen.findByTestId('search-input')).toBeInTheDocument();
    expect(screen.getByTestId('filter-chip-row')).toBeInTheDocument();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('passes URL filters through to the entries query', async () => {
    setupApi({
      universe: { id: 'U1', entryTypes: ['character'] },
      categories: [],
      entriesByQuery: (path) => {
        // Only the query that includes ?q=dragon should return the match.
        if (path.includes('q=dragon')) return [mkEntry('e1', 'Dragon of the North')];
        return [];
      },
    });

    renderAt('/universes/U1/entries?q=dragon');

    expect(await screen.findByText('Dragon of the North')).toBeInTheDocument();
  });

  it('shows the filter-aware empty state when a query yields no results', async () => {
    setupApi({
      universe: { id: 'U1', entryTypes: ['character'] },
      categories: [],
      entriesByQuery: () => [],
    });

    renderAt('/universes/U1/entries?q=nomatch');

    expect(
      await screen.findByText(/no entries match your filters/i),
    ).toBeInTheDocument();
    // Clear-filters button should be present as an action.
    expect(
      screen.getByRole('button', { name: /clear filters/i }),
    ).toBeInTheDocument();
  });

  it('shows the original empty state when the universe has no entries and no filters active', async () => {
    setupApi({
      universe: { id: 'U1', entryTypes: ['character'] },
      categories: [],
      entriesByQuery: () => [],
    });

    renderAt('/universes/U1/entries');

    expect(await screen.findByText(/no entries yet/i)).toBeInTheDocument();
    // Create-entry CTA from the existing empty state stays.
    expect(
      screen.getByRole('link', { name: /create your first entry/i }),
    ).toBeInTheDocument();
  });

  it('clicking "Clear filters" invokes the URL updater to reset all filters', async () => {
    setupApi({
      universe: { id: 'U1', entryTypes: ['character'] },
      categories: [],
      entriesByQuery: () => [],
    });

    renderAt('/universes/U1/entries?q=nomatch&type=character');

    const clearBtn = await screen.findByRole('button', { name: /clear filters/i });
    await userEvent.click(clearBtn);

    // After clearing, the universe-empty copy should appear (no filters → no results → default empty state).
    expect(await screen.findByText(/no entries yet/i)).toBeInTheDocument();
  });
});
