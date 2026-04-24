import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the filter-params hook so we can drive filters + observe updates.
const updateFiltersMock = vi.fn();
let currentFilters = {
  q: '',
  type: null as string | null,
  tags: [] as string[],
  category: null as string | null,
};
vi.mock('../hooks/useFilterParams', () => ({
  useFilterParams: () => [currentFilters, updateFiltersMock],
}));

// Mock api client so useUniverse + useCategories resolve without a network.
vi.mock('../api/client', () => ({
  api: vi.fn(async (path: string) => {
    if (path === '/universes/U1') {
      return { id: 'U1', entryTypes: ['character', 'place', 'event'] };
    }
    if (path === '/universes/U1/categories') {
      return {
        categories: [
          { id: 'cat-1', label: 'Nobles', icon: '👑', sortOrder: 0, entryCount: 2 },
        ],
        uncategorizedCount: 0,
      };
    }
    return undefined;
  }),
}));

import { FilterChipRow } from './FilterChipRow';

function renderRow() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/universes/U1/entries']}>
        <FilterChipRow universeId="U1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('FilterChipRow', () => {
  beforeEach(() => {
    updateFiltersMock.mockReset();
    currentFilters = { q: '', type: null, tags: [], category: null };
  });

  it('renders one chip per active filter (type, tags, category)', async () => {
    currentFilters = {
      q: '',
      type: 'place',
      tags: ['coast', 'dragon'],
      category: 'cat-1',
    };
    renderRow();

    expect(await screen.findByText(/Type: place/i)).toBeInTheDocument();
    expect(screen.getByText(/Tag: coast/i)).toBeInTheDocument();
    expect(screen.getByText(/Tag: dragon/i)).toBeInTheDocument();
    // Category chip resolves the id to the category label.
    expect(await screen.findByText(/Category: Nobles/i)).toBeInTheDocument();
  });

  it('removes a tag filter when the × is clicked', async () => {
    currentFilters = { q: '', type: null, tags: ['coast', 'dragon'], category: null };
    renderRow();

    const removeCoast = await screen.findByRole('button', { name: /Remove Tag: coast/i });
    await userEvent.click(removeCoast);

    expect(updateFiltersMock).toHaveBeenCalledWith({ tags: ['dragon'] });
  });

  it('removes the type filter when its × is clicked', async () => {
    currentFilters = { q: '', type: 'event', tags: [], category: null };
    renderRow();

    const removeType = await screen.findByRole('button', { name: /Remove Type: event/i });
    await userEvent.click(removeType);

    expect(updateFiltersMock).toHaveBeenCalledWith({ type: null });
  });

  it('opens the add-filter popover with type/tag/category sub-actions', async () => {
    renderRow();

    const addBtn = await screen.findByRole('button', { name: /add filter/i });
    await userEvent.click(addBtn);

    // All three filter dimensions should be reachable inside the popover.
    expect(await screen.findByLabelText(/add type filter/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/add tag filter/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/add category filter/i)).toBeInTheDocument();
  });

  it('renders the Uncategorized label for the category=uncategorized sentinel', async () => {
    currentFilters = { q: '', type: null, tags: [], category: 'uncategorized' };
    renderRow();

    expect(await screen.findByText(/Category: Uncategorized/i)).toBeInTheDocument();
  });
});
