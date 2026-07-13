import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEntryMedallions } from './useEntryMedallions';
import { api } from '../api/client';

vi.mock('../api/client', () => ({ api: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useEntryMedallions', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('maps entry id → medallion source from the entries list', async () => {
    vi.mocked(api).mockResolvedValue([
      { id: 'e1', title: 'Aldric', entryType: 'entity', icon: '👑', coverThumbUrl: '/thumb-1.png' },
      { id: 'e2', title: 'Vale', entryType: 'location', icon: '', coverThumbUrl: null },
    ] as never);

    const { result } = renderHook(() => useEntryMedallions('u1'), { wrapper });

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('e1')).toEqual({
      title: 'Aldric',
      entryType: 'entity',
      icon: '👑',
      coverThumbUrl: '/thumb-1.png',
    });
    expect(result.current.get('e2')?.coverThumbUrl).toBeNull();
  });

  it('reads the SAME query as useEntries — no second request, no new cache key', async () => {
    // Re-keying a shared query key is a recorded footgun in this project
    // (react-query-key-change-blast-radius). This hook must be a pure read of the
    // existing entries cache.
    vi.mocked(api).mockResolvedValue([] as never);
    const { result } = renderHook(() => useEntryMedallions('u1'), { wrapper });
    await waitFor(() => expect(result.current).toBeInstanceOf(Map));
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api)).toHaveBeenCalledWith('/universes/u1/entries');
  });

  it('returns an empty map while the list is still loading', () => {
    vi.mocked(api).mockReturnValue(new Promise(() => {}) as never);
    const { result } = renderHook(() => useEntryMedallions('u1'), { wrapper });
    expect(result.current.size).toBe(0);
  });

  it('returns a stable Map identity across re-renders when the data has not changed', async () => {
    // The canvases pass this straight into d3 effects / memo deps. A fresh Map every
    // render would retrigger the graph's whole simulation effect on every parent render.
    vi.mocked(api).mockResolvedValue([
      { id: 'e1', title: 'Aldric', entryType: 'entity', icon: '', coverThumbUrl: null },
    ] as never);

    const { result, rerender } = renderHook(() => useEntryMedallions('u1'), { wrapper });
    await waitFor(() => expect(result.current.size).toBe(1));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
