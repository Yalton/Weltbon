import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { TimelineView } from './TimelineView';
import type { TimelinePin } from '../hooks/useTimelinePins';

function renderAt(path = '/universes/U1/timeline') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/universes/:uid/timeline" element={<TimelineView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TimelineView', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders EmptyState "No pins yet" when timeline is empty', async () => {
    vi.mocked(api).mockResolvedValue([]);
    renderAt();

    expect(await screen.findByText(/no pins yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/open an entry and add one from its timeline section/i),
    ).toBeInTheDocument();
  });

  it('renders era as sticky header with non-era pins underneath', async () => {
    const pins: TimelinePin[] = [
      {
        id: 'p1',
        entryId: 'E1',
        label: 'First Age',
        position: -10000,
        precision: 'era',
        entryTitle: 'First Age',
        entryType: 'era',
      },
      {
        id: 'p2',
        entryId: 'E2',
        label: 'Founding',
        position: 0,
        precision: 'exact',
        entryTitle: 'Founding of Gondor',
        entryType: 'event',
      },
      {
        id: 'p3',
        entryId: 'E3',
        label: 'Battle',
        position: 100,
        precision: 'approximate',
        entryTitle: 'Battle of Pelennor',
        entryType: 'event',
      },
    ];
    vi.mocked(api).mockResolvedValue(pins);
    renderAt();

    expect(await screen.findByText('Founding')).toBeInTheDocument();
    expect(screen.getByText('Battle')).toBeInTheDocument();

    // Era heading is an h2 with sticky styling
    const eraHeading = screen.getByRole('heading', { level: 2, name: /first age/i });
    expect(eraHeading.className).toContain('sticky');
  });

  it('pin rows are clickable Links to /universes/:uid/entries/:entryId', async () => {
    vi.mocked(api).mockResolvedValue([
      {
        id: 'p1',
        entryId: 'E42',
        label: 'Founding',
        position: 100,
        precision: 'exact',
        entryTitle: 'Founding of Gondor',
        entryType: 'event',
      },
    ]);
    renderAt();

    const link = await screen.findByRole('link', { name: /founding/i });
    expect(link).toHaveAttribute('href', '/universes/U1/entries/E42');
  });

  it('preserves API order in DOM (server returns sorted ASC)', async () => {
    vi.mocked(api).mockResolvedValue([
      { id: 'p1', entryId: 'E1', label: 'First', position: 100, precision: 'exact' },
      { id: 'p2', entryId: 'E2', label: 'Second', position: 200, precision: 'exact' },
      { id: 'p3', entryId: 'E3', label: 'Third', position: 300, precision: 'exact' },
    ]);
    renderAt();

    await screen.findByText('First');
    const links = screen.getAllByRole('link');
    const labels = links.map(
      (l) => within(l).getByText(/(first|second|third)/i).textContent,
    );
    expect(labels).toEqual(['First', 'Second', 'Third']);
  });

  it('shows Loading… while the timeline query is pending', async () => {
    let resolveFn: (value: unknown) => void = () => {};
    vi.mocked(api).mockReturnValue(
      new Promise((res) => {
        resolveFn = res;
      }),
    );

    renderAt();

    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
    resolveFn([]);
  });
});
