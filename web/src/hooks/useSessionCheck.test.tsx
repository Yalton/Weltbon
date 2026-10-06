import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAuthStore } from '../store/auth';
import { useSessionCheck } from './useSessionCheck';

const refreshCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/refresh')).length;

describe('useSessionCheck', () => {
  beforeEach(() => useAuthStore.getState().clearSession());
  afterEach(() => vi.unstubAllGlobals());

  it('asks the server once per page load, not every time a signed-out visitor returns home', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    useAuthStore.setState({ signedOut: false });

    const first = renderHook(() => useSessionCheck());
    await waitFor(() => expect(first.result.current).toBe('anonymous'));
    first.unmount();

    const second = renderHook(() => useSessionCheck());
    expect(second.result.current).toBe('anonymous');
    expect(refreshCalls(fetchMock)).toBe(1);
  });

  it('reports a signed-in user without asking the server', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    useAuthStore.getState().setSession({ id: 'u1', email: 'a@example.com', displayName: 'A' }, 'token');

    const { result } = renderHook(() => useSessionCheck());
    expect(result.current).toBe('ok');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
