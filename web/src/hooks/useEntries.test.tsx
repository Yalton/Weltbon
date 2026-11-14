import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', () => ({
  api: vi.fn(),
  getShareToken: () => null,
}));
import { api } from '../api/client';
import { useCreateEntry, useUpdateEntry, useDeleteEntry } from './useEntries';

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { invalidateSpy, wrapper };
}

// The sidebar's per-category entry counts come from the ['categories', uid]
// query. Every entry mutation can change them — a create or delete moves a
// count, and an update can move an entry between categories — so each one must
// refresh that query. Before GitHub issue #25 none did, and the sidebar showed
// stale counts until the app was restarted.
describe('entry mutations refresh the sidebar category counts', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('useCreateEntry invalidates [categories, universeId]', async () => {
    vi.mocked(api).mockResolvedValue({ id: 'e1' });
    const { invalidateSpy, wrapper } = setup();
    const { result } = renderHook(() => useCreateEntry('U1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ title: 'Darrow County', categoryId: 'c1' } as never);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['entries', 'U1'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['categories', 'U1'] });
  });

  it('useUpdateEntry invalidates [categories, universeId]', async () => {
    vi.mocked(api).mockResolvedValue({ id: 'e1' });
    const { invalidateSpy, wrapper } = setup();
    const { result } = renderHook(() => useUpdateEntry('U1', 'e1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ categoryId: 'c2' } as never);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['categories', 'U1'] });
  });

  it('useDeleteEntry invalidates [categories, universeId]', async () => {
    vi.mocked(api).mockResolvedValue(undefined);
    const { invalidateSpy, wrapper } = setup();
    const { result } = renderHook(() => useDeleteEntry('U1'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync('e1');
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['categories', 'U1'] });
  });
});
