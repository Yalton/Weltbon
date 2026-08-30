/**
 * #50 Task 9 — administrator panel for granting/revoking shared LLM access.
 *
 * Mirrors SharedLlmConnections.test.tsx's negative-assertion discipline (see
 * that file's header): a "must never render X" claim is worthless unless a
 * simulated leak of X is shown to fail the assertion. The admin panel's
 * `AdminSharedGrant` type LEGITIMATELY carries owner and recipient identity
 * (displayName/email) — unlike the recipient's `SharedGrant`, hiding that
 * from an administrator would make the grant list useless. What must never
 * render here is key material: ciphertext, a plaintext secret, a key's
 * bodySuffix/keyId, or a provider endpoint. The poison fixtures below attach
 * exactly those as extra properties the type does not declare, so a
 * component that started rendering `grant.apiKey` or similar would fail the
 * redaction check without needing a test written against that specific
 * field name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', async () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return { api: vi.fn(), ApiError };
});

import { api, ApiError } from '../api/client';
import { AdminSharedLlmConnections } from './AdminSharedLlmConnections';
import type { AdminSharedGrant } from '../hooks/useLlmShares';
import type { AdminUser } from '../hooks/useAdminUsers';

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const ACTIVE_USER: AdminUser = {
  id: 'user-active-1',
  email: 'bob@corp.example',
  displayName: 'Bob Recipient',
  createdAt: '2026-01-01T00:00:00.000Z',
  isAdmin: false,
  disabledAt: null,
  disabledReason: null,
};

const DISABLED_USER: AdminUser = {
  id: 'user-disabled-1',
  email: 'carol@corp.example',
  displayName: 'Carol Disabled',
  createdAt: '2026-01-01T00:00:00.000Z',
  isAdmin: false,
  disabledAt: '2026-02-01T00:00:00.000Z',
  disabledReason: 'left the team',
};

const ADMIN_GRANT: AdminSharedGrant = {
  id: 'grant-1',
  owner: { id: 'admin-1', displayName: 'Alice Admin', email: 'alice.admin@corp.example' },
  recipient: { id: 'user-active-1', displayName: 'Bob Recipient', email: 'bob@corp.example' },
  provider: 'anthropic',
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  revokedAt: null,
  revokedReason: null,
  consentedAt: '2026-08-02T00:00:00.000Z',
  usage: {
    monthStart: '2026-08-01',
    settledUsd: '0.2500',
    reservedUsd: '0.0500',
    limitUsd: '1.0000',
    activeAudits: 1,
    maxConcurrentAudits: 1,
    completedAudits: 3,
    failedAudits: 1,
  },
};

/** Every VALUE the poison fixture carries — what a leak would render. */
const POISON_VALUES = [
  'sk-ant-owner-plaintext-secret',
  'c1ph3rt3xt-owner-key',
  'QZ4T',
  'owner-key-uuid-1',
  'api.anthropic.com/v1/messages',
];

function expectNoKeyMaterial() {
  const text = document.body.textContent ?? '';
  const attributeValues: string[] = [];
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) attributeValues.push(attr.value);
  }
  const haystack = `${text}\n${attributeValues.join('\n')}`;
  for (const secret of POISON_VALUES) {
    expect(haystack).not.toContain(secret);
  }
  expect(haystack).not.toContain('••••');
}

function withPoison(grant: AdminSharedGrant): AdminSharedGrant {
  return {
    ...grant,
    apiKey: 'sk-ant-owner-plaintext-secret',
    ciphertext: 'c1ph3rt3xt-owner-key',
    bodySuffix: 'QZ4T',
    keyId: 'owner-key-uuid-1',
    endpoint: 'api.anthropic.com/v1/messages',
  } as unknown as AdminSharedGrant;
}

function mockApi(opts: {
  users?: AdminUser[];
  grants?: AdminSharedGrant[];
  onPost?: (body: unknown) => AdminSharedGrant | Promise<AdminSharedGrant>;
  onDelete?: (id: string) => void | Promise<void>;
}) {
  const calls: Array<[string, RequestInit | undefined]> = [];
  vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
    calls.push([path, init]);
    const method = init?.method ?? 'GET';
    if (path === '/admin/users' && method === 'GET') {
      return Promise.resolve((opts.users ?? [ACTIVE_USER]) as never);
    }
    if (path === '/admin/llm-shares' && method === 'GET') {
      return Promise.resolve((opts.grants ?? []) as never);
    }
    if (path === '/admin/llm-shares' && method === 'POST') {
      const body = JSON.parse(init!.body as string);
      if (opts.onPost) return opts.onPost(body) as never;
      return Promise.resolve({ ...ADMIN_GRANT, ...body } as never);
    }
    if (path.startsWith('/admin/llm-shares/') && method === 'DELETE') {
      const id = path.split('/').pop()!;
      if (opts.onDelete) return Promise.resolve(opts.onDelete(id)) as never;
      return Promise.resolve(undefined as never);
    }
    return Promise.resolve(undefined as never);
  });
  return calls;
}

function renderPanel() {
  const qc = makeClient();
  render(<AdminSharedLlmConnections />, {
    wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper>,
  });
  return qc;
}

describe('AdminSharedLlmConnections', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('lists only active users in the recipient select', async () => {
    mockApi({ users: [ACTIVE_USER, DISABLED_USER], grants: [] });
    renderPanel();

    // The <label>/<select> render immediately; the user list arrives async
    // — wait for an actual option (not just the always-present placeholder)
    // before asserting on the option set.
    await screen.findByRole('option', { name: /Bob Recipient/i });
    const select = screen.getByLabelText(/user/i);
    const options = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(options.some((t) => t?.includes('Bob Recipient'))).toBe(true);
    expect(options.some((t) => t?.includes('Carol Disabled'))).toBe(false);
  });

  it('grants access by POSTing exactly { recipientUserId, provider } and refetches the list', async () => {
    let grantsAfterCreate = false;
    const calls = mockApi({
      users: [ACTIVE_USER],
      get grants() {
        return grantsAfterCreate ? [withPoison(ADMIN_GRANT)] : [];
      },
      onPost: (body) => {
        grantsAfterCreate = true;
        return Promise.resolve({ ...ADMIN_GRANT, ...(body as object) });
      },
    });
    renderPanel();

    await screen.findByRole('option', { name: new RegExp(ACTIVE_USER.displayName) });
    const userSelect = screen.getByLabelText(/user/i);
    await userEvent.selectOptions(userSelect, ACTIVE_USER.id);
    const providerSelect = screen.getByLabelText(/provider/i);
    await userEvent.selectOptions(providerSelect, 'anthropic');
    await userEvent.click(screen.getByRole('button', { name: /grant/i }));

    await waitFor(() => {
      expect(calls.some(([p, i]) => p === '/admin/llm-shares' && i?.method === 'POST')).toBe(true);
    });
    const post = calls.find(([p, i]) => p === '/admin/llm-shares' && i?.method === 'POST')!;
    const body = JSON.parse(post[1]!.body as string);
    // Exactly two fields — no third, ever (global constraint).
    expect(body).toEqual({ recipientUserId: ACTIVE_USER.id, provider: 'anthropic' });
    expect(Object.keys(body).sort()).toEqual(['provider', 'recipientUserId']);

    // The list refetched and now shows the new row.
    await waitFor(() => {
      expect(screen.getByText(ACTIVE_USER.email)).toBeInTheDocument();
    });
  });

  it('renders owner/recipient/provider/status/consent/usage/failure data and no key material', async () => {
    mockApi({ users: [ACTIVE_USER], grants: [withPoison(ADMIN_GRANT)] });
    renderPanel();

    expect(await screen.findByText('Alice Admin')).toBeInTheDocument();
    expect(screen.getByText('alice.admin@corp.example')).toBeInTheDocument();
    expect(screen.getByText('Bob Recipient')).toBeInTheDocument();
    expect(screen.getByText('bob@corp.example')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    expect(screen.getByText(/active/i)).toBeInTheDocument();
    expect(screen.getByText(/consented|accepted/i)).toBeInTheDocument();
    // Usage: settled / limit.
    expect(screen.getByText(/0\.2500/)).toBeInTheDocument();
    expect(screen.getByText(/1\.0000/)).toBeInTheDocument();
    // Failure count.
    expect(screen.getByText(/1 failed|failed.*1/i)).toBeInTheDocument();

    expectNoKeyMaterial();
  });

  it('LEAK CHECK: expectNoKeyMaterial fails when key material actually renders (proves the assertion is not vacuous)', () => {
    document.body.innerHTML = '<div title="sk-ant-owner-plaintext-secret">leaked</div>';
    expect(() => expectNoKeyMaterial()).toThrow();
    document.body.innerHTML = '';
  });

  it('revokes an active row after confirmation, calling DELETE by grant id', async () => {
    let deletedId: string | undefined;
    const calls = mockApi({
      users: [ACTIVE_USER],
      grants: [ADMIN_GRANT],
      onDelete: (id) => {
        deletedId = id;
      },
    });
    renderPanel();

    await screen.findByText(ACTIVE_USER.email);
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));
    // Confirmation gate — no DELETE yet.
    expect(calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);

    const dialogConfirm = await screen.findByRole('button', { name: /^revoke$/i });
    await userEvent.click(dialogConfirm);

    await waitFor(() => {
      expect(deletedId).toBe(ADMIN_GRANT.id);
    });
  });

  it('shows an alert and keeps the row when revoke fails, without implying access was cut', async () => {
    // Review finding: revoke.mutate was called with only onSuccess — a
    // failed revoke (403/409/network) left the row in place with NO
    // message anywhere, so an administrator would reasonably (and
    // wrongly) conclude access had been cut.
    mockApi({
      users: [ACTIVE_USER],
      grants: [ADMIN_GRANT],
      onDelete: () => Promise.reject(new ApiError(403, {}, 'Only the owning administrator can revoke this connection')),
    });
    renderPanel();

    await screen.findByText(ACTIVE_USER.email);
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));
    const dialogConfirm = await screen.findByRole('button', { name: /^revoke$/i });
    await userEvent.click(dialogConfirm);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only the owning administrator can revoke this connection',
    );
    // The row must still show as active — a failed revoke must not read as
    // a successful one, and the grant must not silently vanish either.
    expect(screen.getByText(ACTIVE_USER.email)).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('shows a safe message and keeps it visible for a duplicate-grant (409) error', async () => {
    const calls = mockApi({
      users: [ACTIVE_USER],
      grants: [],
      onPost: () =>
        Promise.reject(
          new ApiError(409, {}, 'An active shared connection already exists'),
        ),
    });
    renderPanel();

    await screen.findByRole('option', { name: new RegExp(ACTIVE_USER.displayName) });
    const userSelect = screen.getByLabelText(/user/i);
    await userEvent.selectOptions(userSelect, ACTIVE_USER.id);
    await userEvent.click(screen.getByRole('button', { name: /grant/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An active shared connection already exists',
    );
    // The error must still be visible after the DOM has had a moment to
    // settle — a prior bug class in this codebase cleared error state on an
    // unrelated re-render.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'An active shared connection already exists',
    );
    expect(calls.filter(([p, i]) => p === '/admin/llm-shares' && i?.method === 'POST')).toHaveLength(1);
  });
});
