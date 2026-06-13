import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';

vi.mock('../api/client', () => ({ api: vi.fn() }));
import { api } from '../api/client';
import { useCreateLink, useDeleteLink, type Link } from './useLinks';

function wrapperFactory(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

const fixtureLink: Link = {
  id: 'L1',
  universeId: 'U1',
  sourceEntryId: 'A',
  targetEntryId: 'B',
  label: 'knows',
  linkType: null,
  direction: 'directed',
  createdAt: '2026-05-16T00:00:00Z',
};

describe('useCreateLink', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('invalidates ["graph-data", universeId] on success (regression: GRAPH-04 bug fix)', async () => {
    vi.mocked(api).mockResolvedValue(fixtureLink);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateLink('U1'), {
      wrapper: wrapperFactory(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({
        sourceEntryId: 'A',
        targetEntryId: 'B',
        label: 'knows',
      });
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown[] }).queryKey),
    );
    expect(invalidatedKeys).toContain(JSON.stringify(['entry', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['relations', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['graph-data', 'U1']));
  });
});

describe('useDeleteLink', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('invalidates ["graph-data", universeId] on success (defense-in-depth)', async () => {
    vi.mocked(api).mockResolvedValue(undefined);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteLink('U1'), {
      wrapper: wrapperFactory(qc),
    });

    await act(async () => {
      await result.current.mutateAsync('L1');
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown[] }).queryKey),
    );
    expect(invalidatedKeys).toContain(JSON.stringify(['entry', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['relations', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['graph-data', 'U1']));
  });
});
