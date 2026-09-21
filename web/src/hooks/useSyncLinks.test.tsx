import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', () => ({
  api: vi.fn(),
  getShareToken: () => null,
}));
import { api } from '../api/client';
import {
  useSyncLinks,
  useCreateSyncLink,
  useDeleteSyncLink,
  useRunSyncLink,
  useSetLinkAutoSync,
  type SyncLink,
  type SyncRunResult,
} from './useSyncLinks';
import { SYNC_REMOTES_QUERY_KEY, syncLinksKey, syncConflictsKey } from './syncKeys';

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

/**
 * Braced body, NOT `beforeEach(() => vi.mocked(api).mockReset())`: the concise
 * form RETURNS the mock, and vitest runs a function returned from beforeEach as
 * a teardown callback — it would call api() with no arguments after every test.
 * Do not shorten it.
 */
beforeEach(() => {
  vi.mocked(api).mockReset();
});

const LINK: SyncLink = {
  id: 'l1',
  universeId: 'u1',
  remoteId: 'r1',
  remoteLabel: 'Laptop',
  remoteBaseUrl: 'http://localhost:3001',
  status: 'idle',
  lastSyncedAt: '2026-08-04T00:00:00.000Z',
  lastError: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  autoSync: true,
  pausedReason: null,
  nextPollAt: null,
  failureCount: 0,
};

const RESULT: SyncRunResult = {
  linkId: 'l1',
  bootstrapped: false,
  conflicts: 0,
  blobsPushed: 0,
  blobsPulled: 0,
  assetsRepairedLocally: 0,
  assetsRepairedOnPeer: 0,
  assetsSweptOnPeer: 0,
  assetsUnrepairable: 0,
  pushed: { upserted: {}, deleted: {} },
  appliedLocally: { upserted: {}, deleted: {} },
};

/** The path handed to api() by the Nth (default: first) call. */
function pathOfCall(n = 0): string {
  return String(vi.mocked(api).mock.calls[n][0]);
}

describe('useSyncLinks', () => {
  it('GETs /sync/links with the universe id in the query', async () => {
    vi.mocked(api).mockResolvedValue([LINK]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncLinks('u1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.data).toEqual([LINK]));
    expect(api).toHaveBeenCalledWith('/sync/links?universeId=u1');
  });

  it('does not fire without a universe id', async () => {
    // `useParams` hands the Sync tab `string | undefined`, and the server
    // validates `universeId: z.string().uuid()` — a request built from
    // `undefined` is a guaranteed 400 rendered as a load error on a tab the
    // user has done nothing wrong on.
    vi.mocked(api).mockResolvedValue([LINK]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncLinks(undefined), { wrapper: makeWrapper(qc) });

    // A disabled query never leaves pending, so there is no settled state to
    // wait for; assert the absence directly after letting the effects flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(api).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('keys the query with syncLinksKey so the remote-delete cascade reaches it', async () => {
    vi.mocked(api).mockResolvedValue([LINK]);
    const qc = makeClient();

    renderHook(() => useSyncLinks('u1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(qc.getQueryData(syncLinksKey('u1'))).toEqual([LINK]));
  });
});

describe('useCreateSyncLink', () => {
  it('POSTs {universeId, remoteId} to /sync/links', async () => {
    vi.mocked(api).mockResolvedValue(LINK);
    const qc = makeClient();

    const { result } = renderHook(() => useCreateSyncLink('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ remoteId: 'r1' });
    });

    expect(api).toHaveBeenCalledWith('/sync/links', expect.objectContaining({ method: 'POST' }));
    // Parsed, not string-compared: JSON.stringify pins key ORDER, so
    // reordering the hook's object literal — a no-op — would fail this.
    const body = String((vi.mocked(api).mock.calls[0][1] as RequestInit).body);
    expect(JSON.parse(body)).toEqual({ universeId: 'u1', remoteId: 'r1' });
  });

  it('invalidates this universe’s links, and not the remotes list', async () => {
    // Creating a link changes no account-scoped remote row.
    vi.mocked(api).mockResolvedValue(LINK);
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateSyncLink('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ remoteId: 'r1' });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: syncLinksKey('u1') });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: SYNC_REMOTES_QUERY_KEY });
  });
});

describe('useDeleteSyncLink', () => {
  it('DELETEs /sync/links/:id', async () => {
    vi.mocked(api).mockResolvedValue({ deleted: true });
    const qc = makeClient();

    const { result } = renderHook(() => useDeleteSyncLink('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'l1' });
    });

    expect(api).toHaveBeenCalledWith(
      '/sync/links/l1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('invalidates this universe’s links, and not the remotes list', async () => {
    vi.mocked(api).mockResolvedValue({ deleted: true });
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteSyncLink('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'l1' });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: syncLinksKey('u1') });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: SYNC_REMOTES_QUERY_KEY });
  });
});

describe('useSetLinkAutoSync', () => {
  it('PATCHes /sync/links/:id with { autoSync }', async () => {
    vi.mocked(api).mockResolvedValue({ ...LINK, autoSync: false });
    const qc = makeClient();

    const { result } = renderHook(() => useSetLinkAutoSync('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ linkId: 'l1', autoSync: false });
    });

    expect(api).toHaveBeenCalledWith(
      '/sync/links/l1',
      expect.objectContaining({ method: 'PATCH' }),
    );
    const body = String((vi.mocked(api).mock.calls[0][1] as RequestInit).body);
    expect(JSON.parse(body)).toEqual({ autoSync: false });
  });

  it('invalidates this universe’s links, and not the remotes list', async () => {
    vi.mocked(api).mockResolvedValue({ ...LINK, autoSync: true });
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useSetLinkAutoSync('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ linkId: 'l1', autoSync: true });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: syncLinksKey('u1') });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: SYNC_REMOTES_QUERY_KEY });
  });
});

describe('useRunSyncLink', () => {
  it('POSTs /sync/links/:id/run with NO force query by default', async () => {
    vi.mocked(api).mockResolvedValue(RESULT);
    const qc = makeClient();

    const { result } = renderHook(() => useRunSyncLink('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'l1' });
    });

    expect(pathOfCall()).toBe('/sync/links/l1/run');
    // Not merely "the default is not true" — `?force=false` would also pass a
    // negative on the value while still being a query the ordinary run must
    // not send.
    expect(pathOfCall()).not.toContain('force');
  });

  it('POSTs ?force=true when the caller forces the run', async () => {
    // F-02's recovery path: the server lease is 30 minutes, so a claim left
    // behind by a closed tab would otherwise wedge the link for that long.
    vi.mocked(api).mockResolvedValue(RESULT);
    const qc = makeClient();

    const { result } = renderHook(() => useRunSyncLink('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'l1', force: true });
    });

    expect(pathOfCall()).toBe('/sync/links/l1/run?force=true');
    expect(api).toHaveBeenCalledWith(
      '/sync/links/l1/run?force=true',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns the run result to the caller', async () => {
    vi.mocked(api).mockResolvedValue({ ...RESULT, conflicts: 3 });
    const qc = makeClient();

    const { result } = renderHook(() => useRunSyncLink('u1'), { wrapper: makeWrapper(qc) });

    let returned: SyncRunResult | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync({ id: 'l1' });
    });

    expect(returned?.conflicts).toBe(3);
  });

  it('invalidates every content cache after success because a run can change any synced collection', async () => {
    vi.mocked(api).mockResolvedValue(RESULT);
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRunSyncLink('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'l1' });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: syncLinksKey('u1') });
    expect(spy).toHaveBeenCalledWith({ queryKey: syncConflictsKey('u1') });
    // No arguments = every query. Sync can change roughly 17 collections,
    // whose cache keys do not share a safe universe-scoped prefix.
    expect(spy).toHaveBeenCalledWith();
  });

  it('invalidates links on FAILURE too — the remedy only arrives via lastError', async () => {
    // THE reason the run mutation uses onSettled and not onSuccess.
    //
    // `blob-unavailable`'s `side` — WHICH instance is missing the bytes — is
    // not on the wire: the route serializes only {error, code}. The server
    // writes the side into `sync_links.last_error` BEFORE the route returns its
    // error, so the only path by which that remedy reaches the user is a
    // refetch of the link row. With onSuccess, a failed run leaves the cached
    // row carrying the PREVIOUS last_error (or none), and the user is told
    // nothing about which side to fix.
    const failure = new Error('boom');
    vi.mocked(api).mockRejectedValue(failure);
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRunSyncLink('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await expect(result.current.mutateAsync({ id: 'l1' })).rejects.toThrow('boom');
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: syncLinksKey('u1') });
    expect(spy).toHaveBeenCalledWith({ queryKey: syncConflictsKey('u1') });
    // A failed run may have committed the local apply before a later step
    // failed, so stale content is unsafe on this path too.
    expect(spy).toHaveBeenCalledWith();
  });
});
