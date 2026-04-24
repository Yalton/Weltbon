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

    // Plan 10 adds an ellipsis menu trigger per row — scope to the collapse
    // button via exact name match on the category label.
    const button = await screen.findByRole('button', { name: 'Characters' });
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

  it('renders a "New category" button that opens CategoryManageDialog', async () => {
    vi.mocked(api).mockResolvedValue({ categories: [], uncategorizedCount: 0 });

    renderSidebar();

    const newBtn = await screen.findByRole('button', { name: /new category/i });
    await userEvent.click(newBtn);

    // Dialog uses Radix -- look for the dialog + its title role
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Title is a Radix Dialog.Title — present in the a11y tree as a heading
    expect(screen.getByRole('heading', { name: /new category/i })).toBeInTheDocument();
  });

  it('shows a Rename/Delete menu when the ellipsis trigger is clicked', async () => {
    vi.mocked(api).mockResolvedValue({
      categories: [
        { id: 'c1', label: 'Characters', icon: '🧝', sortOrder: 0, entryCount: 12 },
      ],
      uncategorizedCount: 0,
    });

    renderSidebar();

    const trigger = await screen.findByRole('button', { name: /category actions for characters/i });
    await userEvent.click(trigger);

    // Menu items from Radix DropdownMenu render as menuitems
    expect(await screen.findByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });
});

// Pure-function unit tests for the drag-end reorder helper. dnd-kit's keyboard
// coordinate-getter doesn't work reliably in jsdom, so we export the pure
// arrayMove-based helper and test it in isolation.
describe('computeNewCategoryOrder', () => {
  it('moves the active id to the over-id slot and returns the new id list', async () => {
    const { computeNewCategoryOrder } = await import('./categoryReorder');
    const ids = ['a', 'b', 'c', 'd'];
    expect(computeNewCategoryOrder(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(computeNewCategoryOrder(ids, 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  });

  it('returns the same list when active === over', async () => {
    const { computeNewCategoryOrder } = await import('./categoryReorder');
    const ids = ['a', 'b', 'c'];
    expect(computeNewCategoryOrder(ids, 'b', 'b')).toEqual(['a', 'b', 'c']);
  });

  it('returns the same list when either id is missing', async () => {
    const { computeNewCategoryOrder } = await import('./categoryReorder');
    const ids = ['a', 'b', 'c'];
    expect(computeNewCategoryOrder(ids, 'a', 'zzz')).toEqual(['a', 'b', 'c']);
    expect(computeNewCategoryOrder(ids, 'zzz', 'a')).toEqual(['a', 'b', 'c']);
  });
});
