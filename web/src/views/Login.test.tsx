import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Login } from './Login';

function renderLogin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/universes" element={<div>Universes page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Login view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('names the page in the document title', () => {
    renderLogin();
    expect(document.title).toBe('Log in · Weltbon');
  });

  it('submits credentials and navigates to /universes on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ accessToken: 'tok', user: { id: 'u1', email: 'a@b.com', displayName: 'A' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'longenoughpw12');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ email: 'a@b.com', password: 'longenoughpw12' });
    await waitFor(() => expect(screen.queryByText(/universes page/i)).toBeInTheDocument());
  });

  it('shows an error when login returns 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid credentials' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrongwrongwrong');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid credentials/i));
  });
});
