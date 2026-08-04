/**
 * Plan F (Task 2) — hooks for the account-scoped `/api/sync/remotes` surface.
 *
 * Mirrors useCategories.test.tsx's scaffolding: the api() client is mocked at
 * the module boundary, each test builds its own QueryClient with retry off,
 * and invalidation is asserted by spying on the client rather than by
 * observing a refetch (which would depend on subscriber timing).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query';
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
  SYNC_REMOTES_QUERY_KEY,
  SYNC_LINKS_QUERY_PREFIX,
  type SyncRemote,
} from './useSyncRemotes';

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    mutationCache: new MutationCache({
      onError: () => {
        /* intentionally empty — tests assert via mutateAsync rejection */
      },
    }),
  });
}

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
  beforeEach(() => vi.mocked(api).mockReset());

  it('GETs /sync/remotes and returns the masked array', async () => {
    vi.mocked(api).mockResolvedValue([REMOTE]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncRemotes(), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.data).toEqual([REMOTE]));
    expect(api).toHaveBeenCalledWith('/sync/remotes');
  });
});

describe('useCreateSyncRemote', () => {
  beforeEach(() => vi.mocked(api).mockReset());

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

    expect(api).toHaveBeenCalledWith('/sync/remotes', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        label: 'Laptop',
        baseUrl: 'http://localhost:3001',
        pat: 'wb_pat_secret',
      }),
    }));
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
  beforeEach(() => vi.mocked(api).mockReset());

  it('PATCHes /sync/remotes/:id with only the fields supplied', async () => {
    vi.mocked(api).mockResolvedValue({ ...REMOTE, label: 'Desktop' });
    const qc = makeClient();

    const { result } = renderHook(() => useUpdateSyncRemote(), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'r1', label: 'Desktop' });
    });

    expect(api).toHaveBeenCalledWith('/sync/remotes/r1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ label: 'Desktop' }),
    }));
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
  beforeEach(() => vi.mocked(api).mockReset());

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

describe('useTestSyncRemote', () => {
  beforeEach(() => vi.mocked(api).mockReset());

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
