import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndContext } from '@dnd-kit/core';
import type { Entry } from '../hooks/useEntries';
import type { TimelinePin } from '../hooks/useTimelinePins';

// Mock useFilteredEntries so we can drive the panel from the test.
vi.mock('../hooks/useFilteredEntries', () => ({
  useFilteredEntries: vi.fn(),
}));
import { useFilteredEntries } from '../hooks/useFilteredEntries';
import { TimelineEntryPanel } from './TimelineEntryPanel';

function makeEntry(id: string, title: string, overrides: Partial<Entry> = {}): Entry {
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePin(entryId: string, position = 0): TimelinePin {
  return {
    id: `pin-${entryId}`,
    entryId,
    label: `${entryId} label`,
    position,
    precision: 'exact',
  };
}

function renderPanel(opts: { universeId?: string; pins?: TimelinePin[] } = {}) {
  const { universeId = 'U1', pins = [] } = opts;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DndContext>
        <TimelineEntryPanel universeId={universeId} pins={pins} />
      </DndContext>
    </QueryClientProvider>,
  );
}

describe('TimelineEntryPanel', () => {
  beforeEach(() => {
    vi.mocked(useFilteredEntries).mockReset();
  });

  it('renders entries returned by useFilteredEntries', () => {
    vi.mocked(useFilteredEntries).mockReturnValue({
      data: [makeEntry('e1', 'Aelara'), makeEntry('e2', 'Borin')],
      isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderPanel();

    expect(screen.getByText('Aelara')).toBeInTheDocument();
    expect(screen.getByText('Borin')).toBeInTheDocument();
  });

  it('shows a "Pinned" badge on entries that have a pin and labels it for screen readers', () => {
    vi.mocked(useFilteredEntries).mockReturnValue({
      data: [makeEntry('e1', 'Aelara'), makeEntry('e2', 'Borin')],
      isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderPanel({ pins: [makePin('e1')] });

    const badge = screen.getByLabelText('Already pinned to timeline');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Pinned');
  });

  it('pinned entry card is NOT marked draggable (no cursor-grab, aria-disabled set)', () => {
    vi.mocked(useFilteredEntries).mockReturnValue({
      data: [makeEntry('e1', 'Aelara')],
      isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderPanel({ pins: [makePin('e1')] });

    const card = screen.getByTestId('timeline-entry-card-e1');
    expect(card.className).not.toMatch(/cursor-grab/);
    expect(card).toHaveAttribute('aria-disabled', 'true');
  });

  it('unpinned entry card is draggable (cursor-grab + dnd-kit attribute)', () => {
    vi.mocked(useFilteredEntries).mockReturnValue({
      data: [makeEntry('e1', 'Aelara')],
      isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderPanel({ pins: [] });

    const card = screen.getByTestId('timeline-entry-card-e1');
    expect(card.className).toMatch(/cursor-grab/);
    // useDraggable's `attributes` always includes a `role` attribute on the
    // draggable element ("button"). Its presence here is the proof that the
    // card has been wrapped by useDraggable (vs. the pinned branch).
    expect(card).toHaveAttribute('role', 'button');
  });

  it('typing in the search input updates filter state and re-queries useFilteredEntries with the new q', async () => {
    vi.mocked(useFilteredEntries).mockReturnValue({
      data: [],
      isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderPanel();

    const search = screen.getByPlaceholderText(/search entries/i);
    await userEvent.type(search, 'ael');

    await waitFor(() => {
      const lastCall = vi.mocked(useFilteredEntries).mock.calls.at(-1);
      expect(lastCall?.[0]).toBe('U1');
      expect(lastCall?.[1].q).toBe('ael');
    });
  });

  it('shows the "No entries" empty state when there are no entries AND no filters are set', () => {
    vi.mocked(useFilteredEntries).mockReturnValue({
      data: [],
      isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderPanel();

    expect(screen.getByText('No entries')).toBeInTheDocument();
    expect(
      screen.getByText('Add entries to this universe before pinning them to the timeline.'),
    ).toBeInTheDocument();
  });

  it('shows the "Nothing matches these filters" empty state when there are no entries AND a filter is active', async () => {
    vi.mocked(useFilteredEntries).mockReturnValue({
      data: [],
      isLoading: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    renderPanel();

    const search = screen.getByPlaceholderText(/search entries/i);
    await userEvent.type(search, 'zzz');

    await waitFor(() => {
      expect(screen.getByText('Nothing matches these filters')).toBeInTheDocument();
    });
    expect(
      screen.getByText('Try removing a filter or clearing the search.'),
    ).toBeInTheDocument();
  });
});
