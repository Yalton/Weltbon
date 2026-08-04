/**
 * Plan F (Task 2) — hooks for the account-scoped `/api/sync/remotes` surface.
 *
 * Mirrors useCategories.test.tsx's scaffolding: the api() client is mocked at
 * the module boundary, each test builds its own QueryClient with retry off,
 * and invalidation is asserted by spying on the client rather than by
 * observing a refetch (which would depend on subscriber timing). It drops that
 * file's MutationCache.onError swallow — see the failure-path test below for
 * why this file does not need one.
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
import {
  useSyncRemotes,
  useCreateSyncRemote,
  useUpdateSyncRemote,
  useDeleteSyncRemote,
  useTestSyncRemote,
  type SyncRemote,
} from './useSyncRemotes';
import { SYNC_REMOTES_QUERY_KEY, SYNC_LINKS_QUERY_PREFIX } from './syncKeys';

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
 * One top-level reset for every describe below.
 *
 * Braced body, NOT `beforeEach(() => vi.mocked(api).mockReset())`: the concise
 * form returns the mock, and vitest treats a function returned from beforeEach
 * as a teardown callback — it would then call api() with no arguments after
 * every test. Harmless while each test here uses mockResolvedValue, but it
 * breaks loudly and confusingly the moment a test dispatches on the path
 * argument (as SyncSettings.test.tsx does). Do not shorten it.
 */
beforeEach(() => {
  vi.mocked(api).mockReset();
});

const REMOTE: SyncRemote = {
  id: 'r1',
  label: 'Laptop',
  baseUrl: 'http://localhost:3001',
  patSuffix: '4f2a',
  createdAt: '2026-08-04T00:00:00.000Z',
};

/** The JSON body string handed to api() by the Nth (default: first) call. */
function bodyOfCall(n = 0): string {
  const call = vi.mocked(api).mock.calls[n];
  return String((call[1] as RequestInit | undefined)?.body ?? '');
}

describe('useSyncRemotes', () => {
  it('GETs /sync/remotes and returns the masked array', async () => {
    vi.mocked(api).mockResolvedValue([REMOTE]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncRemotes(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.data).toEqual([REMOTE]));
    expect(api).toHaveBeenCalledWith('/sync/remotes');
  });
});

describe('useCreateSyncRemote', () => {
  it('POSTs {label, baseUrl, pat} to /sync/remotes', async () => {
    vi.mocked(api).mockResolvedValue(REMOTE);
    const qc = makeClient();

    const { result } = renderHook(() => useCreateSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({
        label: 'Laptop',
        baseUrl: 'http://localhost:3001',
        pat: 'wb_pat_secret',
      });
    });

    expect(api).toHaveBeenCalledWith('/sync/remotes', expect.objectContaining({ method: 'POST' }));
    // Parsed, not string-compared: JSON.stringify pins key ORDER, so
    // reordering the hook's object literal — a no-op — would fail this.
    expect(JSON.parse(bodyOfCall())).toEqual({
      label: 'Laptop',
      baseUrl: 'http://localhost:3001',
      pat: 'wb_pat_secret',
    });
  });

  it("invalidates ['sync','remotes'] on success", async () => {
    vi.mocked(api).mockResolvedValue(REMOTE);
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ label: '', baseUrl: 'http://x', pat: 'p' });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: SYNC_REMOTES_QUERY_KEY });
  });
});

describe('useUpdateSyncRemote', () => {
  it('PATCHes /sync/remotes/:id with only the fields supplied', async () => {
    vi.mocked(api).mockResolvedValue({ ...REMOTE, label: 'Desktop' });
    const qc = makeClient();

    const { result } = renderHook(() => useUpdateSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'r1', label: 'Desktop' });
    });

    expect(api).toHaveBeenCalledWith('/sync/remotes/r1', expect.objectContaining({ method: 'PATCH' }));
    expect(JSON.parse(bodyOfCall())).toEqual({ label: 'Desktop' });
  });

  it('omits `pat` from the body entirely when no new token is supplied', async () => {
    // The server validates `pat: z.string().min(1).optional()`. `undefined`
    // disappears through JSON.stringify, but a hook that built the body as
    // `{ label, baseUrl, pat: pat ?? '' }` would send an empty string and eat
    // a 400 on every label-only edit. Assert against the SERIALIZED body so
    // the key's absence is what is pinned, not the value's.
    vi.mocked(api).mockResolvedValue(REMOTE);
    const qc = makeClient();

    const { result } = renderHook(() => useUpdateSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'r1', label: 'Desktop', baseUrl: 'http://y' });
    });

    expect(bodyOfCall()).not.toContain('pat');
    expect(JSON.parse(bodyOfCall())).toEqual({ label: 'Desktop', baseUrl: 'http://y' });
  });

  it('includes `pat` when a replacement token IS supplied', async () => {
    vi.mocked(api).mockResolvedValue(REMOTE);
    const qc = makeClient();

    const { result } = renderHook(() => useUpdateSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'r1', pat: 'wb_pat_new' });
    });

    expect(JSON.parse(bodyOfCall())).toEqual({ pat: 'wb_pat_new' });
  });

  it("invalidates ['sync','remotes'] on success", async () => {
    vi.mocked(api).mockResolvedValue(REMOTE);
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'r1', label: 'Desktop' });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: SYNC_REMOTES_QUERY_KEY });
  });
});

describe('useDeleteSyncRemote', () => {
  it('DELETEs /sync/remotes/:id', async () => {
    vi.mocked(api).mockResolvedValue(undefined);
    const qc = makeClient();

    const { result } = renderHook(() => useDeleteSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'r1' });
    });

    expect(api).toHaveBeenCalledWith('/sync/remotes/r1', expect.objectContaining({
      method: 'DELETE',
    }));
  });

  it("invalidates the ['sync','links'] prefix as well as ['sync','remotes']", async () => {
    // `sync_links.remote_id` is `onDelete: 'cascade'` (api/src/db/schema.ts:775),
    // so deleting a remote destroys its links in EVERY universe that used it —
    // not only the universe currently on screen. This module is account-scoped
    // and cannot know which universes those were, so it must invalidate the
    // whole links prefix rather than one universe's key.
    vi.mocked(api).mockResolvedValue(undefined);
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'r1' });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: SYNC_REMOTES_QUERY_KEY });
    expect(spy).toHaveBeenCalledWith({ queryKey: SYNC_LINKS_QUERY_PREFIX });
  });
});

describe('useDeleteSyncRemote — failure path', () => {
  it('invalidates NOTHING when the DELETE fails', async () => {
    // Deliberately unlike `useRevokeLlmKey`, which also invalidates onError to
    // clear a row lost to a 404 race. Here a failed delete means the remote —
    // and every link that cascades from it — is still there, so dropping the
    // caches would replace a correct list with a refetch that returns the same
    // rows, and briefly imply to the user that something changed.
    //
    // No MutationCache.onError swallow is needed for this (useCategories.test
    // carries one for its own rejection tests): on vitest 3.2.4 + TanStack v5
    // the rejection is delivered to the awaited `mutateAsync` and consumed by
    // the assertion below, so nothing reaches the unhandled-rejection handler.
    // Verified by removing the swallow: still 13 passed, exit 0, no Errors.
    const failure = new Error('boom');
    vi.mocked(api).mockRejectedValue(failure);
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await expect(result.current.mutateAsync({ id: 'r1' })).rejects.toThrow('boom');
    });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useTestSyncRemote', () => {
  it("POSTs /sync/remotes/:id/test and returns the peer's identity", async () => {
    const identity = {
      ok: true as const,
      remote: { weltbonVersion: '1.0', appVersion: '3.2.0', migrationHead: '0027' },
    };
    vi.mocked(api).mockResolvedValue(identity);
    const qc = makeClient();

    const { result } = renderHook(() => useTestSyncRemote(), { wrapper: makeWrapper(qc) });

    let returned: unknown;
    await act(async () => {
      returned = await result.current.mutateAsync({ id: 'r1' });
    });

    expect(api).toHaveBeenCalledWith('/sync/remotes/r1/test', expect.objectContaining({
      method: 'POST',
    }));
    expect(returned).toEqual(identity);
  });

  it('does not invalidate the remotes list (a handshake changes nothing)', async () => {
    vi.mocked(api).mockResolvedValue({
      ok: true,
      remote: { weltbonVersion: '1.0', appVersion: '3.2.0', migrationHead: '0027' },
    });
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useTestSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'r1' });
    });

    expect(spy).not.toHaveBeenCalled();
  });
});
