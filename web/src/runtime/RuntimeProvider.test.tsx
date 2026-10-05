import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { clearAccessToken, getAccessToken } from '../api/client';
import { useAuthStore } from '../store/auth';
import { RuntimeProvider, useRuntime } from './RuntimeProvider';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchSequence(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function LandingChild() {
  const { landing } = useRuntime();
  return <div>landing {String(landing.inviteRequestsEnabled)} {landing.repoUrl}</div>;
}

function RuntimeChild() {
  const { authMode } = useRuntime();
  return <div>application ({authMode})</div>;
}

describe('RuntimeProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearAccessToken();
    useAuthStore.setState({ user: null });
  });

  it('establishes a local session before rendering children', async () => {
    const fetchMock = mockFetchSequence(
      json({ authMode: 'local' }),
      json({ accessToken: 'local-token' }),
      json({ id: 'local-id', email: 'local@weltbon.app', displayName: 'Local' }),
    );

    render(<RuntimeProvider><RuntimeChild /></RuntimeProvider>);

    expect(screen.queryByText(/^application \(/)).not.toBeInTheDocument();
    expect(await screen.findByText('application (local)')).toBeInTheDocument();
    expect(useAuthStore.getState().user?.id).toBe('local-id');
    expect(getAccessToken()).toBe('local-token');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/runtime',
      '/api/auth/local-session',
      '/api/auth/me',
    ]);
  });

  it('does not create a local session in server mode', async () => {
    const fetchMock = mockFetchSequence(json({ authMode: 'server' }));

    render(<RuntimeProvider><RuntimeChild /></RuntimeProvider>);

    expect(await screen.findByText('application (server)')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate local startup when StrictMode replays the effect', async () => {
    const fetchMock = mockFetchSequence(
      json({ authMode: 'local' }),
      json({ accessToken: 'local-token' }),
      json({ id: 'local-id', email: 'local@weltbon.app', displayName: 'Local' }),
    );

    render(
      <StrictMode>
        <RuntimeProvider><RuntimeChild /></RuntimeProvider>
      </StrictMode>,
    );

    expect(await screen.findByText('application (local)')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/runtime',
      '/api/auth/local-session',
      '/api/auth/me',
    ]);
  });

  it('keeps login hidden and retries a failed local startup', async () => {
    const fetchMock = mockFetchSequence(
      json({ authMode: 'local' }),
      new Response(null, { status: 500 }),
      json({ accessToken: 'local-token' }),
      json({ id: 'local-id', email: 'local@weltbon.app', displayName: 'Local' }),
    );

    render(<RuntimeProvider><RuntimeChild /></RuntimeProvider>);

    expect(await screen.findByRole('heading', { name: 'Weltbon could not open' })).toBeInTheDocument();
    expect(screen.queryByText(/log in/i)).not.toBeInTheDocument();
    expect(screen.getByText(/application data folder/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('application (local)')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/runtime',
      '/api/auth/local-session',
      '/api/auth/local-session',
      '/api/auth/me',
    ]);
  });

  it('uses the retry startup surface when capabilities fail before mode is known', async () => {
    const fetchMock = mockFetchSequence(
      new Response(null, { status: 503 }),
      json({ authMode: 'server' }),
    );

    render(<RuntimeProvider><RuntimeChild /></RuntimeProvider>);

    expect(await screen.findByRole('heading', { name: 'Weltbon could not open' })).toBeInTheDocument();
    // The mode is still unknown here, so this surface is equally reachable by a
    // hosted user hitting a transient 5xx. It must not reassure them about a
    // local application data folder they do not have.
    expect(screen.queryByText(/application data folder/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^application \(/)).not.toBeInTheDocument();
    expect(screen.queryByText(/log in/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('application (server)')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes the landing configuration through to children', async () => {
    mockFetchSequence(json({
      authMode: 'server',
      landing: { inviteRequestsEnabled: true, repoUrl: 'https://git.example.com/me/weltbon' },
    }));

    render(<RuntimeProvider><LandingChild /></RuntimeProvider>);

    expect(await screen.findByText('landing true https://git.example.com/me/weltbon')).toBeInTheDocument();
  });

  it.each([
    ['is missing', undefined],
    ['has a non-http repo URL', { inviteRequestsEnabled: true, repoUrl: 'javascript:alert(1)' }],
  ])('falls back to the public repo and no invite form when landing %s', async (_label, landing) => {
    mockFetchSequence(json({ authMode: 'server', landing }));

    render(<RuntimeProvider><LandingChild /></RuntimeProvider>);

    const expected = landing === undefined ? 'false' : 'true';
    expect(await screen.findByText(`landing ${expected} https://github.com/Citreum-LLC/Weltbon`)).toBeInTheDocument();
  });
});
