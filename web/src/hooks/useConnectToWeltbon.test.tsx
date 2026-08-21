/**
 * OB-01 / OB-04. Mirrors the QueryClient wrapper shape used by
 * useAdoptUniverse.test.tsx (makeClient + a Provider wrapper).
 *
 * The mock below preserves the REAL `ApiError` export from '../api/client'
 * (only `api` itself is replaced) — see useConnectToWeltbon.ts's `errorCode`
 * doc comment for why: `api()` always throws `ApiError`, and `ApiError`
 * carries the server's `code` on `.body.code`, not as a top-level property.
 * Constructing error doubles as bare `Object.assign(new Error(...), {code})`
 * would pass against a `toError` that reads `err.code` directly, but that
 * combination doesn't exist at runtime — the real client never throws that
 * shape — so the doubles here are real `ApiError` instances instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useConnectToWeltbon } from './useConnectToWeltbon';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: vi.fn() };
});
import { api, ApiError } from '../api/client';
const mockApi = api as unknown as ReturnType<typeof vi.fn>;

/** Queue one response per call, in order. */
function queue(...responses: Array<unknown | Error>) {
  mockApi.mockReset();
  for (const r of responses) {
    if (r instanceof Error) mockApi.mockRejectedValueOnce(r);
    else mockApi.mockResolvedValueOnce(r);
  }
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}
const wrapper = makeWrapper();

const REMOTE = { id: 'remote-1', label: 'peer.example', baseUrl: 'https://peer.example' };
const TWO = { universes: [
  { id: 'u1', name: 'Alpha', description: '', updatedAt: '', localState: 'absent' },
  { id: 'u2', name: 'Beta',  description: '', updatedAt: '', localState: 'absent' },
] };
const ONE = { universes: [TWO.universes[0]] };
const LINK = { id: 'link-1', universeId: 'u1' };

describe('useConnectToWeltbon', () => {
  beforeEach(() => mockApi.mockReset());

  it('runs the whole flow and ends done', async () => {
    queue(REMOTE, ONE, LINK, { ok: true });
    const { result } = renderHook(() => useConnectToWeltbon(), { wrapper });

    await act(() => result.current.start({ baseUrl: 'https://peer.example', email: 'a@b.c', password: 'pw' }));

    await waitFor(() => expect(result.current.step).toBe('done'));
    expect(result.current.universeId).toBe('u1');
    expect(mockApi).toHaveBeenCalledTimes(4);
  });

  it('stops at choosing when the peer holds more than one universe', async () => {
    queue(REMOTE, TWO);
    const { result } = renderHook(() => useConnectToWeltbon(), { wrapper });

    await act(() => result.current.start({ baseUrl: 'https://peer.example', email: 'a@b.c', password: 'pw' }));

    await waitFor(() => expect(result.current.step).toBe('choosing'));
    expect(result.current.universes).toHaveLength(2);
    expect(mockApi).toHaveBeenCalledTimes(2);
  });

  it('attributes a rejected credential to the authenticating step', async () => {
    const err = new ApiError(
      401,
      { error: 'that instance did not accept the email and password', code: 'peer_credentials_rejected' },
      'that instance did not accept the email and password',
    );
    queue(err);
    const { result } = renderHook(() => useConnectToWeltbon(), { wrapper });

    await act(() => result.current.start({ baseUrl: 'https://peer.example', email: 'a@b.c', password: 'bad' }));

    await waitFor(() => expect(result.current.failedStep).toBe('authenticating'));
    expect(result.current.error?.code).toBe('peer_credentials_rejected');
  });

  it('resumes at the failed step without repeating earlier ones', async () => {
    queue(REMOTE, ONE, LINK, new Error('sync exploded'));
    const { result } = renderHook(() => useConnectToWeltbon(), { wrapper });
    await act(() => result.current.start({ baseUrl: 'https://peer.example', email: 'a@b.c', password: 'pw' }));
    await waitFor(() => expect(result.current.failedStep).toBe('syncing'));
    expect(mockApi).toHaveBeenCalledTimes(4);

    queue({ ok: true });
    await act(() => result.current.retry());

    await waitFor(() => expect(result.current.step).toBe('done'));
    // Exactly one call: the retry re-ran ONLY the sync.
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('treats an already-adopted universe as success and continues to sync', async () => {
    const already = new ApiError(409, { error: 'already local', code: 'universe-already-local' }, 'already local');
    // The recovery path has no linkId from the failed adopt call (the server
    // committed the link on an earlier attempt, but THIS response carries none),
    // so it makes one extra call — GET /sync/links?universeId= — to recover it
    // before it can run the sync. That's 5 calls total, not 4: remotes,
    // universes, adopt (fails already-adopted), the links lookup, sync run.
    const existingLinks = [{ id: 'link-1', universeId: 'u1', remoteId: 'remote-1' }];
    queue(REMOTE, ONE, already, existingLinks, { ok: true });
    const { result } = renderHook(() => useConnectToWeltbon(), { wrapper });

    await act(() => result.current.start({ baseUrl: 'https://peer.example', email: 'a@b.c', password: 'pw' }));

    await waitFor(() => expect(result.current.step).toBe('done'));
    expect(result.current.failedStep).toBeNull();
    expect(result.current.linkId).toBe('link-1');
    expect(mockApi).toHaveBeenCalledTimes(5);
  });

  it('reaches done-with-empty-universe when only the first pull fails, keeping the universe', async () => {
    queue(REMOTE, ONE, LINK, new Error('sync exploded'));
    const { result } = renderHook(() => useConnectToWeltbon(), { wrapper });

    await act(() => result.current.start({ baseUrl: 'https://peer.example', email: 'a@b.c', password: 'pw' }));

    await waitFor(() => expect(result.current.failedStep).toBe('syncing'));
    // The universe was adopted and must remain navigable — OB-04.
    expect(result.current.universeId).toBe('u1');
    expect(result.current.linkId).toBe('link-1');
    // Regression: `step` must agree with `failedStep`, not revert to 'idle'.
    // Task 5's credential-form pane is selected on "step is idle OR
    // failedStep is authenticating" — a stale 'idle' here would send the user
    // back to the credentials form after the universe was already adopted,
    // exactly the bounce-back this feature exists to eliminate.
    expect(result.current.step).toBe('syncing');
  });
});
