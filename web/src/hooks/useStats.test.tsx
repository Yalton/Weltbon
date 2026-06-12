import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { useStats, type Stats } from './useStats';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

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
    {
      id: 'e1',
      title: 'Aragorn',
      entryType: 'character',
      icon: '🧙',
      updatedAt: '2026-06-01T12:00:00Z',
    },
  ],
};

describe('useStats', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('returns the typed stats object when the api client resolves', async () => {
    vi.mocked(api).mockResolvedValue(mockStats);
    const qc = makeClient();

    const { result } = renderHook(() => useStats('U1'), {
      wrapper: makeWrapper(qc),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api).toHaveBeenCalledWith('/universes/U1/stats');
    expect(result.current.data).toEqual(mockStats);
    expect(result.current.data?.totalEntries).toBe(42);
    expect(result.current.data?.entriesByType).toHaveLength(3);
    expect(result.current.data?.recentlyEdited).toHaveLength(1);
  });

  it('is disabled (does not fetch) when uid is undefined', async () => {
    vi.mocked(api).mockResolvedValue(mockStats);
    const qc = makeClient();

    const { result } = renderHook(() => useStats(undefined), {
      wrapper: makeWrapper(qc),
    });

    // When disabled, status should be 'pending' (not yet fetched), not 'success'
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
    expect(api).not.toHaveBeenCalled();
  });
});
