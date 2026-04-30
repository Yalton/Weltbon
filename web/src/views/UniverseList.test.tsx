import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UniverseList } from './UniverseList';
import { setAccessToken } from '../api/client';

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <UniverseList />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('UniverseList view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAccessToken('fake-access-token');
  });

  it('shows the empty state when the API returns []', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    expect(await screen.findByText(/start a universe/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new universe/i })).toBeInTheDocument();
  });

  it('creates a universe when the name form is submitted', async () => {
    const universes: any[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        const created = {
          id: 'uA',
          userId: 'u1',
          name: body.name,
          description: '',
          entryTypes: ['concept'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        universes.push(created);
        return new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(universes), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await screen.findByText(/start a universe/i);
    await userEvent.click(screen.getByRole('button', { name: /new universe/i }));
    const input = await screen.findByPlaceholderText(/universe name/i);
    await userEvent.type(input, 'Post-Sundering');
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }));

    // POST then GET refetch
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, init]: any) => init?.method === 'POST') as
        | [string, RequestInit]
        | undefined;
      expect(postCall).toBeTruthy();
      expect(JSON.parse(postCall![1].body as string)).toEqual({ name: 'Post-Sundering' });
    });
    await waitFor(() => expect(screen.getByText('Post-Sundering')).toBeInTheDocument());
  });
});
