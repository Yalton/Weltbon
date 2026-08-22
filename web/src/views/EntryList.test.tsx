import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock api client so every network call is dispatched by path.
vi.mock('../api/client', () => ({
  getShareToken: () => null,
  api: vi.fn(),
  getAccessToken: () => null,
}));
import { api } from '../api/client';
import { EntryList } from './EntryList';
import { syncConflictsKey } from '../hooks/syncKeys';

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

function mkSyncLink(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    universeId: 'U1',
    remoteId: 'remote-1',
    remoteLabel: 'Home instance',
    remoteBaseUrl: 'https://example.test',
    status: 'idle',
    lastSyncedAt: '2025-01-01T00:00:00.000Z',
    lastError: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function setupApi({
  universe,
  categories,
  entriesByQuery,
  syncLinks = [],
  syncConflicts = [],
}: {
  universe: { id: string; entryTypes: string[] };
  categories: Array<{ id: string; label: string; icon: string; sortOrder: number; entryCount: number }>;
  entriesByQuery: (path: string) => unknown;
  syncLinks?: Array<Record<string, unknown>>;
  syncConflicts?: Array<Record<string, unknown>>;
}) {
  vi.mocked(api).mockImplementation(async (path?: string, init?: { method?: string }) => {
    if (!path) return undefined;
    if (path === '/universes/U1') return universe;
    if (path === '/universes/U1/categories') return { categories, uncategorizedCount: 0 };
    if (path.startsWith('/universes/U1/entries')) return entriesByQuery(path);
    if (path.startsWith('/sync/links?universeId=')) return syncLinks;
    if (path.startsWith('/sync/conflicts?universeId=')) return syncConflicts;
    if (/^\/sync\/links\/[^/]+\/run/.test(path) && init?.method === 'POST') {
      return {
        linkId: 'link-1',
        bootstrapped: true,
        conflicts: 0,
        blobsPushed: 0,
        blobsPulled: 0,
        assetsRepairedLocally: 0,
        assetsRepairedOnPeer: 0,
        assetsSweptOnPeer: 0,
        assetsUnrepairable: 0,
        pushed: { upserted: {}, deleted: {} },
        appliedLocally: { upserted: {}, deleted: {} },
      };
    }
    return undefined;
  });
}

function renderAt(path: string, opts: { state?: unknown } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const initial =
    opts.state !== undefined ? [{ pathname: path, state: opts.state }] : [path];
  // Returns `qc` alongside the render result (spread, not just returned bare)
  // so a test can drive a REFETCH of one query directly — needed to pin the
  // "no stale count after a failed background refetch" behaviour, which
  // cannot be reached by controlling only the FIRST response a mock gives.
  return {
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={initial}>
          <Routes>
            <Route path="/universes/:uid/entries" element={<EntryList />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
    qc,
  };
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

  it('renders the ExportMenu trigger and reveals 4 export items on click', async () => {
    setupApi({
      universe: { id: 'U1', entryTypes: ['character'] },
      categories: [],
      entriesByQuery: () => [mkEntry('e1', 'Alpha')],
    });

    renderAt('/universes/U1/entries');

    // Trigger label is "Export" (not "Export JSON").
    const trigger = await screen.findByRole('button', { name: /^Export/ });
    expect(trigger).toBeInTheDocument();
    // The standalone "Export JSON" button is gone.
    expect(screen.queryByRole('button', { name: /Export JSON/ })).not.toBeInTheDocument();

    await userEvent.click(trigger);

    expect(await screen.findByText('JSON')).toBeInTheDocument();
    expect(screen.getByText('Markdown ZIP')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
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
      await screen.findByText(/nothing matches these filters/i),
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

    expect(await screen.findByText(/start with one idea/i)).toBeInTheDocument();
    // Create-entry CTA is now a button (opens TemplatePicker) instead of a Link.
    expect(
      screen.getByRole('button', { name: /new entry/i }),
    ).toBeInTheDocument();
  });

  it('renders a success toast from location.state.toast on mount', async () => {
    setupApi({
      universe: { id: 'U1', entryTypes: ['character'] },
      categories: [],
      entriesByQuery: () => [],
    });

    renderAt('/universes/U1/entries', {
      state: {
        toast: 'Imported 3 entries, 1 link, 0 new categories.',
        toastVariant: 'success',
      },
    });

    expect(await screen.findByText(/Imported 3 entries/)).toBeInTheDocument();
  });

  it('renders an "Import notes" Link to /universes/:uid/import', async () => {
    setupApi({
      universe: { id: 'U1', entryTypes: ['character'] },
      categories: [],
      entriesByQuery: () => [],
    });

    renderAt('/universes/U1/entries');

    const link = await screen.findByRole('link', { name: /Import notes/i });
    expect(link).toHaveAttribute('href', '/universes/U1/import');
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
    expect(await screen.findByText(/start with one idea/i)).toBeInTheDocument();
  });

  describe('first-sync-failed banner', () => {
    it('renders the banner with a retry action for a link that errored and never synced', async () => {
      setupApi({
        universe: { id: 'U1', entryTypes: ['character'] },
        categories: [],
        entriesByQuery: () => [],
        syncLinks: [mkSyncLink('link-1', { status: 'error', lastSyncedAt: null })],
      });

      renderAt('/universes/U1/entries');

      expect(await screen.findByText(/didn.t finish/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /try again/i }),
      ).toBeInTheDocument();
    });

    it('does not render the banner for a link that errored AFTER a previous successful sync', async () => {
      setupApi({
        universe: { id: 'U1', entryTypes: ['character'] },
        categories: [],
        entriesByQuery: () => [mkEntry('e1', 'Alpha')],
        syncLinks: [
          mkSyncLink('link-1', { status: 'error', lastSyncedAt: '2025-06-01T00:00:00.000Z' }),
        ],
      });

      renderAt('/universes/U1/entries');

      // Wait for the list to settle so the query has resolved either way.
      expect(await screen.findByText('Alpha')).toBeInTheDocument();
      expect(screen.queryByTestId('first-sync-failed-banner')).not.toBeInTheDocument();
    });

    it('renders no banner for a healthy (idle) link', async () => {
      setupApi({
        universe: { id: 'U1', entryTypes: ['character'] },
        categories: [],
        entriesByQuery: () => [mkEntry('e1', 'Alpha')],
        syncLinks: [mkSyncLink('link-1', { status: 'idle', lastSyncedAt: '2025-06-01T00:00:00.000Z' })],
      });

      renderAt('/universes/U1/entries');

      expect(await screen.findByText('Alpha')).toBeInTheDocument();
      expect(screen.queryByTestId('first-sync-failed-banner')).not.toBeInTheDocument();
    });

    it('clicking "Try again" runs sync for that link', async () => {
      setupApi({
        universe: { id: 'U1', entryTypes: ['character'] },
        categories: [],
        entriesByQuery: () => [],
        syncLinks: [mkSyncLink('link-1', { status: 'error', lastSyncedAt: null })],
      });

      renderAt('/universes/U1/entries');

      const retryBtn = await screen.findByRole('button', { name: /try again/i });
      await userEvent.click(retryBtn);

      expect(vi.mocked(api)).toHaveBeenCalledWith(
        '/sync/links/link-1/run',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('unresolved sync conflicts banner (#44, AS-09)', () => {
    function mkConflict(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        universeId: 'U1',
        tableName: 'entries',
        rowId: 'e1',
        winner: 'local',
        loserPayload: { name: 'Replaced name' },
        resolvedAt: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        ...overrides,
      };
    }

    it('shows the count and a link into the Sync tab when conflicts are unresolved', async () => {
      setupApi({
        universe: { id: 'U1', entryTypes: ['character'] },
        categories: [],
        entriesByQuery: () => [mkEntry('e1', 'Alpha')],
        syncConflicts: [mkConflict('c1'), mkConflict('c2')],
      });

      renderAt('/universes/U1/entries');

      const banner = await screen.findByTestId('sync-conflicts-banner');
      expect(banner).toHaveTextContent('2');
      expect(screen.getByRole('link', { name: /review in sync/i })).toHaveAttribute(
        'href',
        '/universes/U1/settings?tab=sync',
      );
    });

    it('renders no banner when there are no unresolved conflicts', async () => {
      setupApi({
        universe: { id: 'U1', entryTypes: ['character'] },
        categories: [],
        entriesByQuery: () => [mkEntry('e1', 'Alpha')],
        syncConflicts: [],
      });

      renderAt('/universes/U1/entries');

      expect(await screen.findByText('Alpha')).toBeInTheDocument();
      expect(screen.queryByTestId('sync-conflicts-banner')).not.toBeInTheDocument();
    });

    it('does not keep displaying a stale count after a failed background refetch', async () => {
      // Pins the review-round-1 fix: EntryList must use `useSyncConflictCount`
      // (which explicitly zeroes on `error`), not a hand-derived
      // `conflicts?.length ?? 0` off `useSyncConflicts` directly — TanStack
      // Query keeps the previous successful rows in `data` across a FAILED
      // REFETCH, so a hand-derived count would keep asserting "2" here after
      // the query has already moved to its error state, while the Sidebar
      // badge (also on `useSyncConflictCount`) has gone silent about it. Two
      // surfaces disagreeing, with the wrong one looking more authoritative.
      let conflictsCall = 0;
      vi.mocked(api).mockImplementation(async (path?: string, init?: { method?: string }) => {
        if (!path) return undefined;
        if (path === '/universes/U1') return { id: 'U1', entryTypes: ['character'] };
        if (path === '/universes/U1/categories') return { categories: [], uncategorizedCount: 0 };
        if (path.startsWith('/universes/U1/entries')) return [mkEntry('e1', 'Alpha')];
        if (path.startsWith('/sync/links?universeId=')) return [];
        if (path.startsWith('/sync/conflicts?universeId=')) {
          conflictsCall += 1;
          if (conflictsCall === 1) return [mkConflict('c1'), mkConflict('c2')];
          throw new Error('boom');
        }
        void init;
        return undefined;
      });

      const { qc } = renderAt('/universes/U1/entries');

      // Positive precondition: the banner really did show the count from the
      // FIRST, successful fetch, so its later absence is not just "it never
      // rendered".
      const banner = await screen.findByTestId('sync-conflicts-banner');
      expect(banner).toHaveTextContent('2');

      // A background refetch of the SAME query, which fails.
      await act(async () => {
        await qc.refetchQueries({ queryKey: syncConflictsKey('U1') });
      });

      await waitFor(() =>
        expect(screen.queryByTestId('sync-conflicts-banner')).not.toBeInTheDocument(),
      );
    });
  });
});
