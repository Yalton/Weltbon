import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Register } from './Register';

function renderRegister() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/register']}>
        <Routes>
          <Route path="/register" element={<Register />} />
          <Route path="/universes" element={<div>Universes page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Register view', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('names the page in the document title', () => {
    renderRegister();
    expect(document.title).toBe('Create your account · Weltbon');
  });

  it('submits all four fields and navigates on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ accessToken: 'tok', user: { id: 'u', email: 'x@y.com', displayName: 'X' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    renderRegister();
    await userEvent.type(screen.getByLabelText(/display name/i), 'Alice');
    await userEvent.type(screen.getByLabelText(/email/i), 'alice@test.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'longenoughpw12');
    await userEvent.type(screen.getByLabelText(/invite code/i), 'CODE123');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/register');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      displayName: 'Alice',
      email: 'alice@test.com',
      password: 'longenoughpw12',
      inviteCode: 'CODE123',
    });
    await waitFor(() => expect(screen.queryByText(/universes page/i)).toBeInTheDocument());
  });

  it('rejects password shorter than 12 chars via client-side validation', async () => {
    renderRegister();
    await userEvent.type(screen.getByLabelText(/display name/i), 'Bob');
    await userEvent.type(screen.getByLabelText(/email/i), 'b@test.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'short');
    await userEvent.type(screen.getByLabelText(/invite code/i), 'C');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/at least 12 characters/i)).toBeInTheDocument();
  });
});
