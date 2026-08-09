/**
 * Adoption hooks (A-04, A-02). Same scaffolding as useSyncRemotes.test.tsx.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', () => ({
  api: vi.fn(),
  getShareToken: () => null,
}));
import { api } from '../api/client';
import { useRemoteUniverses, useAdoptUniverse, useLinkRemoteUniverse } from './useAdoptUniverse';
import { remoteUniversesKey, SYNC_LINKS_QUERY_PREFIX } from './syncKeys';

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

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe('useRemoteUniverses', () => {
  it('unwraps the {universes} envelope so consumers get a bare array', async () => {
    vi.mocked(api).mockResolvedValue({
      universes: [{ id: 'u1', name: 'Aethel', description: '', updatedAt: 'x', localState: 'absent' }],
    });
    const qc = makeClient();
    const { result } = renderHook(() => useRemoteUniverses('r1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].localState).toBe('absent');
    expect(vi.mocked(api).mock.calls[0][0]).toBe('/sync/remotes/r1/universes');
  });

  it('does not fire without a remote id', () => {
    const qc = makeClient();
    renderHook(() => useRemoteUniverses(undefined), { wrapper: makeWrapper(qc) });
    expect(api).not.toHaveBeenCalled();
  });
});

describe('useAdoptUniverse', () => {
  it('posts both ids and invalidates the browse list, the links, and the universe list', async () => {
    vi.mocked(api).mockResolvedValue({ id: 'l1', universeId: 'u1', remoteId: 'r1' });
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useAdoptUniverse(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ remoteId: 'r1', universeId: 'u1' });
    });

    const [path, init] = vi.mocked(api).mock.calls[0];
    expect(path).toBe('/sync/adopt');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ remoteId: 'r1', universeId: 'u1' });

    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    // The adopted universe must appear in the app's universe list immediately —
    // it is the whole point of the action, and nothing else invalidates it.
    expect(keys).toContain(JSON.stringify(['universes']));
    expect(keys).toContain(JSON.stringify(remoteUniversesKey('r1')));
    expect(keys).toContain(JSON.stringify(SYNC_LINKS_QUERY_PREFIX));
  });
});

describe('useLinkRemoteUniverse', () => {
  it('posts to the ordinary link route, not to adopt', async () => {
    vi.mocked(api).mockResolvedValue({ id: 'l1', universeId: 'u1', remoteId: 'r1' });
    const qc = makeClient();
    const { result } = renderHook(() => useLinkRemoteUniverse(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ remoteId: 'r1', universeId: 'u1' });
    });

    expect(vi.mocked(api).mock.calls[0][0]).toBe('/sync/links');
  });
});
