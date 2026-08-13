import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import App from '../App';
import { clearAccessToken } from '../api/client';
import { RuntimeProvider, type AuthMode } from '../runtime/RuntimeProvider';
import { useAuthStore } from '../store/auth';
import { SettingsLayout } from './SettingsLayout';
import { UserMenu } from './UserMenu';

const { loginRender } = vi.hoisted(() => ({ loginRender: vi.fn() }));

vi.mock('./Layout', () => ({ Layout: Outlet }));
vi.mock('./UniverseLayout', () => ({ UniverseLayout: Outlet }));
vi.mock('../views/UniverseList', () => ({
  UniverseList: () => <h1>Universes</h1>,
}));
vi.mock('../views/Login', () => ({
  Login: () => {
    loginRender();
    return <h1>Log in</h1>;
  },
}));
vi.mock('../views/Register', () => ({
  Register: () => <h1>Register</h1>,
}));

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installRuntime(mode: AuthMode) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/runtime') return json({ authMode: mode });
    if (url === '/api/auth/local-session') return json({ accessToken: 'local-token' });
    if (url === '/api/auth/me') {
      return json({ id: 'local-id', email: 'local@weltbon.app', displayName: 'Local' });
    }
    if (url === '/api/auth/refresh') return new Response(null, { status: 401 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderRuntime(mode: AuthMode, path: string, child: React.ReactNode) {
  installRuntime(mode);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <RuntimeProvider>{child}</RuntimeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderLocalApp(path: string) {
  return renderRuntime('local', path, <App />);
}

function renderUserMenu(mode: AuthMode) {
  if (mode === 'server') {
    useAuthStore.getState().setSession(
      { id: 'ada-id', email: 'ada@example.com', displayName: 'Ada' },
      'server-token',
    );
  }
  return renderRuntime(mode, '/', <UserMenu />);
}

function renderLocalSettings() {
  return renderRuntime(
    'local',
    '/settings',
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route index element={<h1>Settings</h1>} />
      </Route>
    </Routes>,
  );
}

describe('runtime-aware navigation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearAccessToken();
    useAuthStore.setState({ user: null });
    loginRender.mockClear();
  });

  it.each([
    ['/login', 'Universes'],
    ['/register', 'Universes'],
    ['/settings/tokens', 'Settings'],
    ['/settings/invites', 'Settings'],
  ])('redirects local mode away from %s without rendering account UI', async (path, destination) => {
    renderLocalApp(path);

    expect(await screen.findByRole('heading', { name: destination })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /log in|register|api tokens|invite codes/i }))
      .not.toBeInTheDocument();
  });

  it('shows a neutral settings-only local user menu', async () => {
    renderUserMenu('local');

    // Local mode exposes Settings as a direct link, not a one-item menu: the
    // accessible name is the visible label, so voice control can reach it.
    const settings = await screen.findByRole('link', { name: 'Settings' });
    expect(settings).toHaveAttribute('href', '/settings');
    expect(screen.queryByText('Local')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Log out' })).not.toBeInTheDocument();
  });

  it('retains identity and logout in the server user menu', async () => {
    renderUserMenu('server');

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'User menu' }));
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
  });

  it('hides only account-only local settings sections', async () => {
    renderLocalSettings();

    expect(await screen.findByText('Templates')).toBeInTheDocument();
    expect(screen.queryByText('API tokens')).not.toBeInTheDocument();
    expect(screen.queryByText('Invite codes')).not.toBeInTheDocument();
    expect(screen.getByText('Shares')).toBeInTheDocument();
    expect(screen.getByText('LLM keys')).toBeInTheDocument();
    expect(screen.getByText('Sync')).toBeInTheDocument();
  });

  it('restores a cleared local session without rendering Login', async () => {
    renderLocalApp('/universes');
    expect(await screen.findByRole('heading', { name: 'Universes' })).toBeInTheDocument();

    act(() => useAuthStore.getState().clearSession());

    await waitFor(() => expect(useAuthStore.getState().user?.id).toBe('local-id'));
    expect(await screen.findByRole('heading', { name: 'Universes' })).toBeInTheDocument();
    expect(loginRender).not.toHaveBeenCalled();
  });
});
