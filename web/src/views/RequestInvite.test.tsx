import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RuntimeValue } from '../runtime/RuntimeProvider';
import { RequestInvite } from './RequestInvite';

const { mockUseRuntime } = vi.hoisted(() => ({
  mockUseRuntime: vi.fn<() => RuntimeValue>(),
}));
vi.mock('../runtime/RuntimeProvider', () => ({ useRuntime: mockUseRuntime }));

function respond(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderRequestInvite(inviteRequestsEnabled = true) {
  mockUseRuntime.mockReturnValue({
    authMode: 'server',
    landing: { inviteRequestsEnabled, repoUrl: 'https://github.com/Yalton/Weltbon' },
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/request-invite']}>
        <Routes>
          <Route path="/request-invite" element={<RequestInvite />} />
          <Route path="/" element={<h1>Landing</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillAndSubmit(fields: { name?: string; email?: string; note?: string }) {
  if (fields.name) await userEvent.type(screen.getByLabelText(/^name/i), fields.name);
  if (fields.email) await userEvent.type(screen.getByLabelText(/^email/i), fields.email);
  if (fields.note) await userEvent.type(screen.getByLabelText(/what would you like to build/i), fields.note);
  await userEvent.click(screen.getByRole('button', { name: /send request/i }));
}

describe('RequestInvite view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows validation errors and does not submit an incomplete form', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderRequestInvite();

    await fillAndSubmit({ email: 'not-an-email' });

    expect(await screen.findByText(/enter your name/i)).toBeInTheDocument();
    expect(screen.getByText(/enter a valid email/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ties each validation error to its field so screen readers read it', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderRequestInvite();

    await fillAndSubmit({ email: 'not-an-email' });

    expect(await screen.findByLabelText(/^name/i)).toHaveAccessibleDescription('Enter your name');
    expect(screen.getByLabelText(/^email/i)).toHaveAccessibleDescription('Enter a valid email');
  });

  it('sends the email lowercased and a blank note as empty, like the API stores them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(202, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderRequestInvite();

    await fillAndSubmit({ name: '  Ada  ', email: 'Ada@Example.COM', note: '   ' });

    await screen.findByRole('heading', { name: /request sent/i });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      name: 'Ada', email: 'ada@example.com', note: '', website: '',
    });
  });

  it('names the page in the document title and avoids jargon', () => {
    renderRequestInvite();
    expect(document.title).toBe('Request an invitation · Weltbon');
    expect(screen.queryByText(/operator/i)).not.toBeInTheDocument();
  });

  it('posts the request and confirms it was sent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(202, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderRequestInvite();

    await fillAndSubmit({ name: 'Ada', email: 'ada@example.com', note: 'A desert empire' });

    expect(await screen.findByRole('heading', { name: /request sent/i })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/invite-requests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Ada', email: 'ada@example.com', note: 'A desert empire', website: '',
    });
  });

  it('tells the visitor to wait when rate limited', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      respond(429, { error: 'Too many requests, try again later', code: 'rate_limited' }),
    ));
    renderRequestInvite();

    await fillAndSubmit({ name: 'Ada', email: 'ada@example.com' });

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many requests, try again later/i);
    expect(screen.queryByRole('heading', { name: /request sent/i })).not.toBeInTheDocument();
  });

  it('shows other failures inline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(500, { error: 'boom' })));
    renderRequestInvite();

    await fillAndSubmit({ name: 'Ada', email: 'ada@example.com' });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not send/i));
  });

  it('keeps the honeypot out of reach of people', () => {
    vi.stubGlobal('fetch', vi.fn());
    renderRequestInvite();

    const trap = document.querySelector<HTMLInputElement>('input[name="website"]');
    expect(trap).not.toBeNull();
    expect(trap).toHaveAttribute('tabindex', '-1');
    expect(trap).toHaveAttribute('autocomplete', 'off');
  });

  it('sends the visitor home when this instance does not take requests', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderRequestInvite(false);

    expect(await screen.findByRole('heading', { name: 'Landing' })).toBeInTheDocument();
  });
});
