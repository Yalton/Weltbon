import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mutable universe fixture (vi.hoisted so it's visible inside the vi.mock
// factory below, which vitest hoists above these imports). Tests that need a
// non-default shape (e.g. a backdropUrl) mutate this before rendering; reset
// in afterEach so tests stay order-independent.
const { universeFixture } = vi.hoisted(() => ({
  universeFixture: {
    id: 'ABC',
    name: 'Ayins Edge',
    theme: { palette: 'ember' } as { palette: string } | null,
    backdropUrl: null as string | null,
    backdropThumbUrl: null as string | null,
  },
}));

// Route-aware api mock: the Sidebar's useCategories fetches
// /universes/:uid/categories while the header breadcrumb's useUniverse
// fetches /universes/:uid — branch on the path so both hooks resolve.
// getShareToken is read synchronously by both hooks (share-seam gate);
// null = authenticated mode.
vi.mock('../api/client', () => ({
  api: vi.fn((path: string) =>
    path.includes('/categories')
      ? Promise.resolve({ categories: [], uncategorizedCount: 0 })
      : Promise.resolve(universeFixture)
  ),
  getShareToken: () => null,
}));
// UserMenu reads auth store + logout hook; stub it so the layout can render
// without a populated auth store.
vi.mock('./UserMenu', () => ({ UserMenu: () => <div data-testid="user-menu-stub" /> }));
// AppBackground uses window.matchMedia which is not available in jsdom
// (same stub as ShareLayout.race.test.tsx).
vi.mock('./AppBackground', () => ({ AppBackground: () => null }));

import { UniverseLayout } from './UniverseLayout';

function renderLayout() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/universes/ABC/entries']}>
        <Routes>
          <Route element={<UniverseLayout />}>
            <Route path="/universes/:uid/entries" element={<div data-testid="outlet-content">entries child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('UniverseLayout', () => {
  afterEach(() => {
    universeFixture.theme = { palette: 'ember' };
    universeFixture.backdropUrl = null;
    universeFixture.backdropThumbUrl = null;
  });

  it('renders the sidebar nav and the matched outlet child', async () => {
    renderLayout();

    // The outlet child should be rendered.
    expect(await screen.findByTestId('outlet-content')).toBeInTheDocument();

    // The sidebar's three nav links should be present with universe-scoped hrefs.
    expect(screen.getByRole('link', { name: /entries/i })).toHaveAttribute(
      'href',
      '/universes/ABC/entries'
    );
    expect(screen.getByRole('link', { name: /graph/i })).toHaveAttribute(
      'href',
      '/universes/ABC/graph'
    );
    expect(screen.getByRole('link', { name: /issues/i })).toHaveAttribute(
      'href',
      '/universes/ABC/issues'
    );
  });

  it('renders the wordmark and the universe-name breadcrumb once the universe loads', async () => {
    renderLayout();

    // Wordmark link back to the universe picker is always present.
    expect(screen.getByRole('link', { name: 'Weltbon' })).toHaveAttribute('href', '/universes');

    // Breadcrumb appears after the useUniverse query resolves.
    expect(await screen.findByText('Ayins Edge')).toBeInTheDocument();
  });

  it('mounts a ThemeScope backdrop when the universe has a backdropUrl', async () => {
    universeFixture.backdropUrl = '/api/universes/ABC/assets/a1/raw?e=1&s=2';

    renderLayout();

    expect(await screen.findByTestId('theme-backdrop')).toBeInTheDocument();
  });
});
