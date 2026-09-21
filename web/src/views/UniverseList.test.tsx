import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UniverseList } from './UniverseList';
import { setAccessToken } from '../api/client';
import type { AuthMode } from '../runtime/RuntimeProvider';

// Mirrors SettingsLayout.test.tsx's runtime mocking: mock the whole module
// rather than wrapping tests in a real RuntimeProvider (which would require
// stubbing /api/runtime + /api/auth/local-session + /api/auth/me for every
// test). Wrapped in vi.hoisted so the mock factory — hoisted above these
// imports by Vitest — can close over a mutable box that individual tests
// can repoint via `mockUseRuntime.mockReturnValue(...)`.
const { mockUseRuntime } = vi.hoisted(() => ({
  mockUseRuntime: vi.fn(() => ({ authMode: 'server' as AuthMode })),
}));
vi.mock('../runtime/RuntimeProvider', () => ({
  useRuntime: mockUseRuntime,
}));

/**
 * Extends the original `renderList()` helper (previously two separate
 * functions: `renderList` and `renderListWithRoutes`) with the
 * `{ universes, authMode }` options the brief's new tests need, while
 * staying source-compatible with every existing call site: called with no
 * arguments, it stubs nothing itself and defaults `authMode` to 'server' —
 * exactly the prior behavior, where each test stubbed its own `fetch`
 * beforehand and no runtime concept existed yet.
 */
function renderUniverseList(
  options: { universes?: unknown[]; authMode?: AuthMode; routes?: boolean } = {},
) {
  const { universes, authMode = 'server', routes = false } = options;
  mockUseRuntime.mockReturnValue({ authMode });

  if (universes) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(universes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  }

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        {routes ? (
          <Routes>
            <Route path="/" element={<UniverseList />} />
            <Route path="/universes/:id/settings" element={<div>SETTINGS_ROUTE</div>} />
          </Routes>
        ) : (
          <UniverseList />
        )}
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderList() {
  return renderUniverseList();
}

function renderListWithRoutes() {
  return renderUniverseList({ routes: true });
}

function makeUniverseFixture() {
  const now = new Date().toISOString();
  return [
    {
      id: 'U1',
      userId: 'u1',
      name: 'Yondergrove',
      description: 'A forested realm.',
      entryTypes: ['concept'],
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'U2',
      userId: 'u1',
      name: 'Tide of Salt',
      description: 'Briny coasts.',
      entryTypes: ['concept'],
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function makeFetchMock(deleteStatus: number = 204) {
  const universes = makeUniverseFixture();
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      if (deleteStatus === 204) return new Response(null, { status: 204 });
      // Server-error branch — used by Test F (status: 500).
      return new Response('{"error":"server_error"}', {
        status: deleteStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(universes), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('UniverseList view', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // vi.restoreAllMocks() only restores vi.spyOn mocks to their original
    // implementation; mockUseRuntime is a plain vi.fn() with no "original"
    // to fall back to, so it must be re-pinned to the default explicitly.
    mockUseRuntime.mockReturnValue({ authMode: 'server' });
    setAccessToken('fake-access-token');
    // Radix Dialog sets `pointer-events: none` on document.body when open;
    // if a previous test left the dialog open at teardown, the next test
    // can't interact with the kebab. Reset body inline styles between tests.
    document.body.style.pointerEvents = '';
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



  it('renders an always-visible kebab on each universe card (Test A)', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await screen.findByText('Yondergrove');

    const kebabs = screen.getAllByRole('button', { name: /actions for/i });
    expect(kebabs).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: /actions for yondergrove/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /actions for tide of salt/i }),
    ).toBeInTheDocument();
  });

  it('opens the menu with Settings and Delete… items and does not navigate (Test B)', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await screen.findByText('Yondergrove');

    const kebab = screen.getByRole('button', { name: /actions for yondergrove/i });
    await user.click(kebab);

    await screen.findByRole('menuitem', { name: /^settings$/i });
    await screen.findByRole('menuitem', { name: /delete/i });

    // List view still rendered — no navigation occurred.
    expect(screen.getByText('Yondergrove')).toBeInTheDocument();
    expect(screen.getByText('Tide of Salt')).toBeInTheDocument();
  });

  it('navigates to settings when the Settings menuitem is selected (Test C)', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderListWithRoutes();
    await screen.findByText('Yondergrove');

    await user.click(
      screen.getByRole('button', { name: /actions for yondergrove/i }),
    );
    const settingsItem = await screen.findByRole('menuitem', {
      name: /^settings$/i,
    });
    await user.click(settingsItem);

    await screen.findByText('SETTINGS_ROUTE');
  });

  it('opens the ConfirmDialog with the typed-confirmation gate disabled on Delete… (Test D)', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await screen.findByText('Yondergrove');

    await user.click(
      screen.getByRole('button', { name: /actions for yondergrove/i }),
    );
    const deleteItem = await screen.findByRole('menuitem', { name: /delete/i });
    await user.click(deleteItem);

    // Dialog title with quoted universe name
    await screen.findByText((content) =>
      content.includes('Delete "Yondergrove"?'),
    );
    // Canonical body copy
    expect(
      screen.getByText(
        /this permanently removes the universe and everything inside it\. this cannot be undone\./i,
      ),
    ).toBeInTheDocument();
    // Typed-confirmation input present (aria-label from ConfirmDialog)
    const input = await screen.findByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    expect(input).toBeInTheDocument();
    // Delete button starts disabled
    const deleteBtn = await screen.findByRole('button', { name: /^delete$/i });
    expect(deleteBtn).toBeDisabled();
  });

  it('enables Delete after exact-match typing and fires DELETE with a success toast (Test E)', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock(204);
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await screen.findByText('Yondergrove');

    await user.click(
      screen.getByRole('button', { name: /actions for yondergrove/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

    const input = await screen.findByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    await user.type(input, 'Yondergrove');

    const deleteBtn = await screen.findByRole('button', { name: /^delete$/i });
    expect(deleteBtn).toBeEnabled();

    await user.click(deleteBtn);

    await waitFor(() => {
      const deletes = fetchMock.mock.calls.filter(
        (c: any[]) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deletes).toHaveLength(1);
      expect(String(deletes[0][0])).toMatch(/\/universes\/U1$/);
    });

    expect(await screen.findByText(/universe deleted\./i)).toBeInTheDocument();
  });

  it('renders an error toast when DELETE returns 500 (Test F)', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock(500);
    vi.stubGlobal('fetch', fetchMock);
    // Silence the expected console.error from handleDelete's catch.
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderList();
    await screen.findByText('Yondergrove');

    await user.click(
      screen.getByRole('button', { name: /actions for yondergrove/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

    const input = await screen.findByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    await user.type(input, 'Yondergrove');

    await user.click(await screen.findByRole('button', { name: /^delete$/i }));

    expect(
      await screen.findByText(/couldn't delete universe\. try again\./i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/universe deleted/i)).not.toBeInTheDocument();

    consoleErr.mockRestore();
  });

  it('preserves the universe and shows no toast when Cancel is clicked (Test G)', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await screen.findByText('Yondergrove');

    await user.click(
      screen.getByRole('button', { name: /actions for yondergrove/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));

    const input = await screen.findByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    expect(input).toBeInTheDocument();

    const cancelBtn = await screen.findByRole('button', { name: /cancel/i });
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: /type universe name to confirm deletion/i,
        }),
      ).not.toBeInTheDocument();
    });

    const deletes = fetchMock.mock.calls.filter(
      (c: any[]) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deletes).toHaveLength(0);
    expect(screen.queryByText(/universe deleted/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't delete/i)).not.toBeInTheDocument();

    // Universe still rendered in the list.
    expect(screen.getByText('Yondergrove')).toBeInTheDocument();
  });

  it('resets the typed-confirmation input across open/close cycles (Test H)', async () => {
    const user = userEvent.setup();
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await screen.findByText('Yondergrove');

    // Open dialog, type partial value, cancel.
    await user.click(
      screen.getByRole('button', { name: /actions for yondergrove/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    let input = await screen.findByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    await user.type(input, 'Yon');
    expect((input as HTMLInputElement).value).toBe('Yon');
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      expect(
        screen.queryByRole('textbox', {
          name: /type universe name to confirm deletion/i,
        }),
      ).not.toBeInTheDocument();
    });

    // Radix sets `pointer-events: none` on <body> while the dialog is open
    // and clears it on close, but in jsdom the cleanup is asynchronous and
    // can race with the next interaction. Clear it explicitly before
    // reopening the menu.
    document.body.style.pointerEvents = '';

    // Reopen via kebab → Delete… and confirm input is empty.
    await user.click(
      screen.getByRole('button', { name: /actions for yondergrove/i }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }));
    input = await screen.findByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    expect((input as HTMLInputElement).value).toBe('');
  });



  it('renders a themed card with its contained backdrop', async () => {
    const themedUniverses = [
      {
        id: 'U1',
        userId: 'u1',
        name: 'Yondergrove',
        description: 'A forested realm.',
        entryTypes: ['concept'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        theme: { palette: 'ember' },
        backdropThumbUrl: '/api/universes/u1/assets/a1/thumb?e=1&s=2',
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(themedUniverses), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await screen.findByText('Yondergrove');

    const img = await screen.findByTestId('theme-backdrop');
    expect(img).toHaveClass('absolute');
    expect((img as HTMLImageElement).src).toContain('/assets/a1/thumb');
  });
});



describe('Connect to Weltbon entry point (OB-05)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUseRuntime.mockReturnValue({ authMode: 'server' });
    setAccessToken('fake-access-token');
    document.body.style.pointerEvents = '';
  });

  it('offers Connect in the empty state when authMode is local', async () => {
    renderUniverseList({ universes: [], authMode: 'local' });
    expect(await screen.findByRole('button', { name: /connect to weltbon/i })).toBeInTheDocument();
  });

  it('offers Connect alongside universes when some already exist', async () => {
    renderUniverseList({ universes: [{ id: 'u1', name: 'Alpha' }], authMode: 'local' });
    expect(await screen.findByRole('button', { name: /connect to weltbon/i })).toBeInTheDocument();
  });

  it('offers nothing when authMode is server', async () => {
    renderUniverseList({ universes: [], authMode: 'server' });
    expect(screen.queryByRole('button', { name: /connect to weltbon/i })).not.toBeInTheDocument();
  });
});
