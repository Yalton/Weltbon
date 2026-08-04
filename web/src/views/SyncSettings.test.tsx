/**
 * SyncSettings view tests — Plan F (Task 2), /settings/sync.
 *
 * Pins:
 *   - The masked list (label / base URL / patSuffix), including a REGRESSION
 *     guard that survives the server growing a plaintext field.
 *   - The F-05 PAT guidance: the token belongs to the OTHER instance.
 *   - The "mint a token there" deep link, and the two ways it must refuse to
 *     render (non-http(s) scheme, unparseable text).
 *   - Test connection: identity on success, syncErrorCopy's copy on failure.
 *   - Edit: the PATCH that re-saves a label without disturbing the PAT.
 *
 * Error prose is asserted against SYNC_ERROR_COPY, never retyped — a test that
 * retyped it would pass against a view that hardcoded its own string.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Keep the REAL ApiError: `syncErrorMessage` narrows with `instanceof
// ApiError` against this same module, so a locally redeclared class would
// make every error fall through to the generic branch and quietly defeat the
// failure tests below.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: vi.fn() };
});

import { api, ApiError } from '../api/client';
import { SYNC_ERROR_COPY } from '../lib/syncErrorCopy';
import SyncSettings from './SyncSettings';

type Handler = unknown | Error | ((path: string, init?: RequestInit) => unknown);

/** Route api() calls by `"<METHOD> <path>"`, falling back to bare `<path>`. */
function makeApiDispatcher(routes: Record<string, Handler>) {
  return vi.fn((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${path}`;
    const handler = key in routes ? routes[key] : routes[path];
    if (handler === undefined) {
      return Promise.reject(new Error(`Unhandled api() call: ${key}`));
    }
    if (handler instanceof Error) return Promise.reject(handler);
    if (typeof handler === 'function') {
      return Promise.resolve((handler as (p: string, i?: RequestInit) => unknown)(path, init));
    }
    return Promise.resolve(handler);
  });
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderView() {
  const qc = makeClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/sync']}>
        <SyncSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const REMOTE = {
  id: 'r1',
  label: 'Laptop',
  baseUrl: 'http://localhost:3001',
  patSuffix: '4f2a',
  createdAt: '2026-08-04T00:00:00.000Z',
};

/** The last JSON body handed to api() for a call matching `method` + `path`. */
function bodyOf(method: string, path: string): string {
  const call = [...vi.mocked(api).mock.calls]
    .reverse()
    .find(([p, init]) => p === path && (init as RequestInit | undefined)?.method === method);
  if (!call) throw new Error(`No ${method} ${path} call recorded`);
  return String((call[1] as RequestInit).body ?? '');
}

// Braces matter: `() => vi.mocked(api).mockReset()` RETURNS the mock, and
// vitest treats a function returned from beforeEach as a teardown callback —
// it would invoke api() with no arguments at the end of every test, which the
// dispatcher below correctly reports as an unhandled call.
beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe('SyncSettings — the remote list', () => {
  it('lists each remote with its label, base URL, and masked token suffix', async () => {
    vi.mocked(api).mockImplementation(makeApiDispatcher({ '/sync/remotes': [REMOTE] }));

    renderView();

    await screen.findByText('Laptop');
    expect(screen.getByText('http://localhost:3001')).toBeInTheDocument();
    expect(screen.getByTestId('remote-pat-r1').textContent).toContain('4f2a');
  });

  it('renders only the suffix even if the server regresses and sends a full token', async () => {
    vi.mocked(api).mockResolvedValue([
      { id: 'r1', label: 'Laptop', baseUrl: 'http://x', patSuffix: '4f2a',
        createdAt: '2026-08-04T00:00:00.000Z', pat: 'super-secret-token-value' },
    ]);
    const { container } = renderView();
    await screen.findByText('Laptop');
    expect(container.textContent).toContain('4f2a');
    expect(container.textContent).not.toContain('super-secret-token-value');
  });

  it('shows an empty state when the account has no remotes', async () => {
    vi.mocked(api).mockImplementation(makeApiDispatcher({ '/sync/remotes': [] }));

    renderView();

    expect(await screen.findByText(/No sync remotes yet/i)).toBeInTheDocument();
  });
});

describe('SyncSettings — the add form (F-05 guidance)', () => {
  it('states that the token is minted on the OTHER instance', async () => {
    vi.mocked(api).mockImplementation(makeApiDispatcher({ '/sync/remotes': [] }));

    renderView();

    const guidance = await screen.findByTestId('sync-pat-guidance');
    // The single most-hit wall for a new user: people paste a token minted on
    // THIS instance and get a 401 they cannot diagnose. Pin the two facts the
    // prose has to carry rather than the whole sentence.
    expect(guidance.textContent).toMatch(/other instance/i);
    expect(guidance.textContent).toMatch(/mint/i);
  });

  it('offers a deep link to the other instance\'s token page once the URL parses', async () => {
    vi.mocked(api).mockImplementation(makeApiDispatcher({ '/sync/remotes': [] }));

    renderView();
    const form = await screen.findByTestId('add-remote-form');

    await userEvent.type(within(form).getByLabelText(/Base URL/i), 'http://localhost:3001');

    await waitFor(() => {
      const link = within(form).getByRole('link');
      expect(link).toHaveAttribute('href', 'http://localhost:3001/settings/tokens');
    });
  });

  it('renders NO link for a javascript: URL', async () => {
    vi.mocked(api).mockImplementation(makeApiDispatcher({ '/sync/remotes': [] }));

    renderView();
    const form = await screen.findByTestId('add-remote-form');

    // `new URL('javascript:alert(1)')` parses happily; only a protocol
    // allow-list stops this becoming a click-to-XSS in the user's own page.
    await userEvent.type(within(form).getByLabelText(/Base URL/i), 'javascript:alert(1)');

    expect(within(form).queryAllByRole('link')).toHaveLength(0);
  });

  it('renders NO link for unparseable text', async () => {
    vi.mocked(api).mockImplementation(makeApiDispatcher({ '/sync/remotes': [] }));

    renderView();
    const form = await screen.findByTestId('add-remote-form');

    await userEvent.type(within(form).getByLabelText(/Base URL/i), 'not a url');

    expect(within(form).queryAllByRole('link')).toHaveLength(0);
  });

  it('POSTs label, base URL and token, and clears the token field afterwards', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [],
        'POST /sync/remotes': REMOTE,
      }),
    );

    renderView();
    const form = await screen.findByTestId('add-remote-form');

    await userEvent.type(within(form).getByLabelText(/Label/i), 'Laptop');
    await userEvent.type(within(form).getByLabelText(/Base URL/i), 'http://localhost:3001');
    await userEvent.type(within(form).getByLabelText(/Access token/i), 'wb_pat_secret');
    await userEvent.click(within(form).getByRole('button', { name: /Add remote/i }));

    await waitFor(() => {
      expect(JSON.parse(bodyOf('POST', '/sync/remotes'))).toEqual({
        label: 'Laptop',
        baseUrl: 'http://localhost:3001',
        pat: 'wb_pat_secret',
      });
    });

    // The plaintext PAT must not linger in a controlled input after the
    // server has it — it is write-only everywhere else in this view.
    await waitFor(() => {
      expect(within(form).getByLabelText(/Access token/i)).toHaveValue('');
    });
  });

  it('renders syncErrorMessage copy when the create fails', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [],
        'POST /sync/remotes': new ApiError(
          401,
          { code: 'remote-unauthorized' },
          'The remote rejected the token',
        ),
      }),
    );

    renderView();
    const form = await screen.findByTestId('add-remote-form');

    await userEvent.type(within(form).getByLabelText(/Base URL/i), 'http://localhost:3001');
    await userEvent.type(within(form).getByLabelText(/Access token/i), 'bad');
    await userEvent.click(within(form).getByRole('button', { name: /Add remote/i }));

    expect(
      await screen.findByText(SYNC_ERROR_COPY['remote-unauthorized'].message),
    ).toBeInTheDocument();
  });
});

describe('SyncSettings — test connection', () => {
  it('renders the peer identity on success', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        'POST /sync/remotes/r1/test': {
          ok: true,
          remote: { weltbonVersion: '1.0', appVersion: '3.2.0', migrationHead: '0027' },
        },
      }),
    );

    renderView();
    await screen.findByText('Laptop');

    await userEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    const status = await screen.findByTestId('remote-test-status-r1');
    expect(status.textContent).toContain('3.2.0');
    expect(status.textContent).toContain('0027');
  });

  it("renders syncErrorMessage's copy on failure", async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        'POST /sync/remotes/r1/test': new ApiError(
          502,
          { code: 'remote-unreachable' },
          'connect ECONNREFUSED 127.0.0.1:3001',
        ),
      }),
    );

    renderView();
    await screen.findByText('Laptop');

    await userEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    const status = await screen.findByTestId('remote-test-status-r1');
    expect(status.textContent).toContain(SYNC_ERROR_COPY['remote-unreachable'].message);
  });
});

describe('SyncSettings — edit', () => {
  it('PATCHes the label without sending a pat when the token field is left blank', async () => {
    // This affordance is the remedy `remote-unauthorized` and
    // `remote-key-undecryptable` both tell the user to perform; without it the
    // app prescribes an action it provides no way to take.
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        'PATCH /sync/remotes/r1': { ...REMOTE, label: 'Desktop' },
      }),
    );

    renderView();
    await screen.findByText('Laptop');

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const form = await screen.findByTestId('edit-remote-form-r1');

    const labelInput = within(form).getByLabelText(/Label/i);
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'Desktop');
    await userEvent.click(within(form).getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(bodyOf('PATCH', '/sync/remotes/r1')).not.toContain('pat');
    });
    expect(JSON.parse(bodyOf('PATCH', '/sync/remotes/r1'))).toEqual({
      label: 'Desktop',
      baseUrl: 'http://localhost:3001',
    });
  });

  it('sends the replacement pat when the token field IS filled', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        'PATCH /sync/remotes/r1': REMOTE,
      }),
    );

    renderView();
    await screen.findByText('Laptop');

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const form = await screen.findByTestId('edit-remote-form-r1');

    await userEvent.type(within(form).getByLabelText(/Access token/i), 'wb_pat_new');
    await userEvent.click(within(form).getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(JSON.parse(bodyOf('PATCH', '/sync/remotes/r1'))).toEqual({
        label: 'Laptop',
        baseUrl: 'http://localhost:3001',
        pat: 'wb_pat_new',
      });
    });
  });

  it('renders syncErrorMessage copy when the edit fails', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        'PATCH /sync/remotes/r1': new ApiError(
          500,
          { code: 'remote-key-undecryptable' },
          'encryption key not configured',
        ),
      }),
    );

    renderView();
    await screen.findByText('Laptop');

    await userEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const form = await screen.findByTestId('edit-remote-form-r1');
    await userEvent.click(within(form).getByRole('button', { name: /Save/i }));

    expect(
      await screen.findByText(SYNC_ERROR_COPY['remote-key-undecryptable'].message),
    ).toBeInTheDocument();
  });
});

describe('SyncSettings — delete', () => {
  it('confirms, DELETEs, and warns that links in every universe go with it', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        'DELETE /sync/remotes/r1': undefined,
      }),
    );

    renderView();
    await screen.findByText('Laptop');

    await userEvent.click(screen.getByRole('button', { name: /^Delete$/i }));

    const dialog = await screen.findByRole('dialog');
    // `sync_links.remote_id` cascades (api/src/db/schema.ts:775) — the
    // confirmation has to say so, because the user is looking at an
    // account-scoped page and cannot see what it will take down.
    expect(dialog.textContent).toMatch(/every universe/i);

    await userEvent.click(within(dialog).getByRole('button', { name: /Delete remote/i }));

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith('/sync/remotes/r1', expect.objectContaining({
        method: 'DELETE',
      }));
    });
  });
});
