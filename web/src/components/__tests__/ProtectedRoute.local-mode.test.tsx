import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '../ProtectedRoute';
import { useAuthStore } from '../../store/auth';

describe('ProtectedRoute local-mode fallback (DV-12)', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null });
    vi.restoreAllMocks();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function renderRoute() {
    return render(
      <MemoryRouter initialEntries={['/private']}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/private" element={<div>PRIVATE</div>} />
          </Route>
          <Route path="/login" element={<div>LOGIN</div>} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('falls back to local-session when refresh fails, and renders the app', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return new Response(null, { status: 401 });
      if (url.includes('/auth/local-session')) {
        return new Response(JSON.stringify({ accessToken: 'local-token' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/auth/me')) {
        return new Response(
          JSON.stringify({ id: 'u1', email: 'local@weltbon.app', displayName: 'Local' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText('PRIVATE')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/local-session'))).toBe(true);
  });

  it('still redirects to /login when BOTH refresh and local-session fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return new Response(null, { status: 401 });
      if (url.includes('/auth/local-session')) return new Response(null, { status: 404 });
      return new Response(null, { status: 404 });
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText('LOGIN')).toBeInTheDocument());
  });
});
