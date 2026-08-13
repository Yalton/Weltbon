import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '../ProtectedRoute';
import { useAuthStore } from '../../store/auth';

describe('ProtectedRoute in server mode', () => {
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

  it('redirects to login after failed refresh without requesting a local session', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) return new Response(null, { status: 401 });
      return new Response(null, { status: 404 });
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText('LOGIN')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
  });
});
