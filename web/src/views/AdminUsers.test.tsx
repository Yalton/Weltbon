/**
 * #50 Task 9 — first test coverage for AdminUsers.tsx (none existed before
 * this task). Covers the pre-existing admin gate + user table at a basic
 * level, plus the one thing this task actually changes: mounting
 * `AdminSharedLlmConnections` on the page. The grant/revoke/redaction
 * behavior of that component itself is exhaustively covered in
 * AdminSharedLlmConnections.test.tsx — this file only proves it is actually
 * on the page an administrator visits.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, api: vi.fn() };
});

import { api } from '../api/client';
import { useAuthStore } from '../store/auth';
import AdminUsers from './AdminUsers';

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/users']}>
        <Routes>
          <Route path="/admin/users" element={children} />
          <Route path="/settings" element={<div>Settings page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const ADMIN_USER = {
  id: 'admin-1',
  email: 'alice.admin@corp.example',
  displayName: 'Alice Admin',
  isAdmin: true,
};

const USERS = [
  {
    id: 'user-1',
    email: 'bob@corp.example',
    displayName: 'Bob Member',
    createdAt: '2026-01-01T00:00:00.000Z',
    isAdmin: false,
    disabledAt: null,
    disabledReason: null,
  },
];

function mockAdminApi() {
  vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/admin/users' && method === 'GET') return Promise.resolve(USERS as never);
    if (path === '/admin/audit-log' && method === 'GET') return Promise.resolve([] as never);
    if (path === '/admin/llm-shares' && method === 'GET') return Promise.resolve([] as never);
    return Promise.resolve(undefined as never);
  });
}

describe('AdminUsers', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    useAuthStore.setState({ user: null });
  });

  it('redirects a non-admin away from the page', () => {
    useAuthStore.setState({ user: { ...ADMIN_USER, isAdmin: false } });
    mockAdminApi();
    render(<AdminUsers />, { wrapper: Wrapper });

    expect(screen.getByText('Settings page')).toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
  });

  it('renders the user table for an admin', async () => {
    useAuthStore.setState({ user: ADMIN_USER });
    mockAdminApi();
    render(<AdminUsers />, { wrapper: Wrapper });

    expect(await screen.findByText('Bob Member')).toBeInTheDocument();
    expect(screen.getByText('bob@corp.example')).toBeInTheDocument();
  });

  it('mounts the shared LLM connections panel for an admin', async () => {
    useAuthStore.setState({ user: ADMIN_USER });
    mockAdminApi();
    render(<AdminUsers />, { wrapper: Wrapper });

    expect(await screen.findByRole('heading', { name: /shared llm connections/i })).toBeInTheDocument();
  });
});
