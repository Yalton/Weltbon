/**
 * Plan F (Task 4) — hooks for the universe-scoped `/api/sync/conflicts` surface.
 *
 * Same scaffolding as useSyncLinks.test.tsx: api() mocked at the module
 * boundary, a fresh QueryClient per test with retry off, and invalidation
 * asserted by spying on the client rather than by observing a refetch (which
 * would depend on subscriber timing).
 *
 * THE COUNT FIXTURE HAS TWO ROWS ON PURPOSE. A one-row fixture passes
 * identically whether the hook returns `data.length` or the constant `1`, so
 * the badge test it feeds (components/Sidebar.test.tsx) could not fail. Two
 * rows is the smallest fixture that distinguishes those two implementations.
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
  useSyncConflicts,
  useSyncConflictCount,
  useResolveConflict,
  useRestoreConflict,
  type SyncConflict,
} from './useSyncConflicts';
import { SYNC_REMOTES_QUERY_KEY, syncConflictsKey, syncLinksKey } from './syncKeys';

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

/**
 * `tableName` is a manifest COLLECTION name and `rowId` is whatever that
 * collection's key function produced (D-14) — both `text`, neither a uuid. The
 * fixtures below deliberately include the `universe` singleton, whose rowId is
 * the literal string 'universe', so nothing here can quietly grow a uuid
 * assumption.
 */
const CONFLICT_NEWER: SyncConflict = {
  id: 'c1',
  universeId: 'u1',
  tableName: 'entries',
  rowId: 'e-77',
  winner: 'remote',
  loserPayload: { id: 'e-77', title: 'Local title that lost' },
  resolvedAt: null,
  createdAt: '2026-08-04T12:00:00.000Z',
};

const CONFLICT_OLDER: SyncConflict = {
  id: 'c2',
  universeId: 'u1',
  tableName: 'universe',
  rowId: 'universe',
  winner: 'local',
  loserPayload: { id: 'u1', name: 'Remote name that lost' },
  resolvedAt: null,
  createdAt: '2026-08-02T09:00:00.000Z',
};

/** The path handed to api() by the Nth (default: first) call. */
function pathOfCall(n = 0): string {
  return String(vi.mocked(api).mock.calls[n][0]);
}

describe('useSyncConflicts', () => {
  it('GETs /sync/conflicts with the universe id in the query', async () => {
    vi.mocked(api).mockResolvedValue([CONFLICT_NEWER, CONFLICT_OLDER]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncConflicts('u1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.data).toEqual([CONFLICT_NEWER, CONFLICT_OLDER]));
    expect(api).toHaveBeenCalledWith('/sync/conflicts?universeId=u1');
  });

  it('does not fire without a universe id', async () => {
    // `universeId` is REQUIRED by the route and validated as a uuid; a request
    // built from `undefined` is a guaranteed 400 painted as a load error on a
    // surface the user has done nothing wrong on.
    vi.mocked(api).mockResolvedValue([CONFLICT_NEWER]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncConflicts(undefined), { wrapper: makeWrapper(qc) });

    // A disabled query never leaves pending, so there is no settled state to
    // wait for; assert the absence directly after letting the effects flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(api).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('keys the query with syncConflictsKey so a run’s invalidation reaches it', async () => {
    // useRunSyncLink invalidates exactly this key. A second array literal here
    // would typecheck, pass, and silently stop matching the day either side is
    // edited — the failure mode syncKeys.ts exists to make impossible.
    vi.mocked(api).mockResolvedValue([CONFLICT_NEWER]);
    const qc = makeClient();

    renderHook(() => useSyncConflicts('u1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(qc.getQueryData(syncConflictsKey('u1'))).toEqual([CONFLICT_NEWER]));
  });

  it('returns the server’s order untouched', async () => {
    // The route promises newest first and the hook must not re-derive that: it
    // is the server's contract, and a client-side sort would silently replace
    // it with a different one the moment `createdAt` ties.
    vi.mocked(api).mockResolvedValue([CONFLICT_NEWER, CONFLICT_OLDER]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncConflicts('u1'), { wrapper: makeWrapper(qc) });

    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.data?.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('useSyncConflictCount', () => {
  it('counts the rows the server returned', async () => {
    vi.mocked(api).mockResolvedValue([CONFLICT_NEWER, CONFLICT_OLDER]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncConflictCount('u1'), { wrapper: makeWrapper(qc) });

    // Two, not one: a single-row fixture would pass against `return 1`.
    await waitFor(() => expect(result.current).toBe(2));
  });

  it('is 0 while the query is still loading', async () => {
    // A badge is read as authoritative. Showing a number before one is known
    // would be a confident lie; showing nothing is merely silence.
    vi.mocked(api).mockReturnValue(new Promise(() => {}));
    const qc = makeClient();

    const { result } = renderHook(() => useSyncConflictCount('u1'), { wrapper: makeWrapper(qc) });

    expect(result.current).toBe(0);
    // Positive precondition: the query really is in flight, so the 0 above is
    // the loading answer rather than the answer to nothing having happened.
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(result.current).toBe(0);
  });

  it('is 0 when the query errors', async () => {
    vi.mocked(api).mockRejectedValue(new Error('boom'));
    const qc = makeClient();

    const { result } = renderHook(
      () => ({ count: useSyncConflictCount('u1'), q: useSyncConflicts('u1') }),
      { wrapper: makeWrapper(qc) },
    );

    // Positive precondition first: the query genuinely reached the error state.
    await waitFor(() => expect(result.current.q.isError).toBe(true));
    expect(result.current.count).toBe(0);
  });

  it('is 0 without a universe id, and fires no request', async () => {
    vi.mocked(api).mockResolvedValue([CONFLICT_NEWER, CONFLICT_OLDER]);
    const qc = makeClient();

    const { result } = renderHook(() => useSyncConflictCount(undefined), {
      wrapper: makeWrapper(qc),
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(0);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('useResolveConflict', () => {
  it('POSTs /sync/conflicts/:id/resolve', async () => {
    vi.mocked(api).mockResolvedValue({ ...CONFLICT_NEWER, resolvedAt: '2026-08-04T13:00:00.000Z' });
    const qc = makeClient();

    const { result } = renderHook(() => useResolveConflict('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'c1' });
    });

    expect(pathOfCall()).toBe('/sync/conflicts/c1/resolve');
    // Not merely "it is not the restore path" — naming the endpoint positively
    // is what makes a copy-paste into `restore` fail here.
    expect(api).toHaveBeenCalledWith(
      '/sync/conflicts/c1/resolve',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('invalidates this universe’s conflicts and nothing else', async () => {
    // Resolve sets `resolvedAt` and does NOT touch the underlying row, so no
    // content cache anywhere can have changed. A blanket invalidation here
    // would refetch the whole app for a no-op.
    vi.mocked(api).mockResolvedValue({ ...CONFLICT_NEWER, resolvedAt: '2026-08-04T13:00:00.000Z' });
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useResolveConflict('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'c1' });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: syncConflictsKey('u1') });
    expect(spy).not.toHaveBeenCalledWith();
    expect(spy).not.toHaveBeenCalledWith({ queryKey: syncLinksKey('u1') });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: SYNC_REMOTES_QUERY_KEY });
  });
});

describe('useRestoreConflict', () => {
  it('POSTs /sync/conflicts/:id/restore', async () => {
    vi.mocked(api).mockResolvedValue({ ...CONFLICT_OLDER, resolvedAt: '2026-08-04T13:00:00.000Z' });
    const qc = makeClient();

    const { result } = renderHook(() => useRestoreConflict('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'c2' });
    });

    expect(pathOfCall()).toBe('/sync/conflicts/c2/restore');
    expect(api).toHaveBeenCalledWith(
      '/sync/conflicts/c2/restore',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('invalidates the conflicts list AND every content cache', async () => {
    // Restore writes the loser payload back through the apply engine, so a real
    // row in a real collection changed. WHICH caches hold it is not knowable
    // from here: `tableName` is opaque text (any of ~17 manifest collections,
    // plus the `universe` singleton), and the web query keys are per-resource
    // literals with no shared prefix. A hand-maintained collection→key map
    // would invalidate NOTHING for a collection it had not caught up to, and
    // the symptom would be a user told the restore worked while looking at the
    // version it replaced. The unfiltered sweep cannot be wrong.
    vi.mocked(api).mockResolvedValue({ ...CONFLICT_OLDER, resolvedAt: '2026-08-04T13:00:00.000Z' });
    const qc = makeClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useRestoreConflict('u1'), { wrapper: makeWrapper(qc) });

    await act(async () => {
      await result.current.mutateAsync({ id: 'c2' });
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: syncConflictsKey('u1') });
    // No arguments = every query. Named explicitly so a later "optimisation"
    // that narrows it has to delete this assertion on purpose.
    expect(spy).toHaveBeenCalledWith();
  });
});
