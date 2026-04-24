import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
  getAccessToken: () => null,
}));
import { api } from '../api/client';
import { IssuesView } from './IssuesView';
import type { Issue, Severity } from '../hooks/useIssues';

function mkIssue(
  id: string,
  title: string,
  severity: Severity,
  resolved = false,
  entries: Array<{ id: string; title: string; icon: string }> = [],
): Issue {
  return {
    id,
    title,
    description: '',
    severity,
    resolved,
    createdAt: '2026-04-01',
    updatedAt: '2026-04-01',
    entries,
  };
}

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/universes/:uid/issues" element={<IssuesView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('IssuesView', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders the issue rows returned by the API and the filter controls', async () => {
    vi.mocked(api).mockImplementation(async (path?: string) => {
      if (path?.startsWith('/universes/U1/issues')) {
        return [
          mkIssue('i1', 'Broken magic system', 'critical'),
          mkIssue('i2', 'Duke name inconsistent', 'major'),
          mkIssue('i3', 'Typo in chapter 4', 'minor'),
        ];
      }
      return undefined;
    });

    renderAt('/universes/U1/issues');

    expect(await screen.findByRole('heading', { name: /issues/i, level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Broken magic system')).toBeInTheDocument();
    expect(screen.getByText('Duke name inconsistent')).toBeInTheDocument();
    expect(screen.getByText('Typo in chapter 4')).toBeInTheDocument();

    // Severity + resolution filters present
    expect(screen.getByLabelText(/severity/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/status/i)).toBeInTheDocument();

    // New issue button
    expect(screen.getByRole('button', { name: /new issue/i })).toBeInTheDocument();
  });

  it('re-fetches with ?severity=critical when the severity filter changes', async () => {
    const apiFn = vi.mocked(api);
    apiFn.mockImplementation(async (path?: string) => {
      if (path === '/universes/U1/issues?resolved=false') {
        return [
          mkIssue('i1', 'Broken magic', 'critical'),
          mkIssue('i2', 'Typo', 'minor'),
        ];
      }
      if (path === '/universes/U1/issues?severity=critical&resolved=false') {
        return [mkIssue('i1', 'Broken magic', 'critical')];
      }
      return [];
    });

    renderAt('/universes/U1/issues');

    // Default: both rows show
    expect(await screen.findByText('Broken magic')).toBeInTheDocument();
    expect(await screen.findByText('Typo')).toBeInTheDocument();

    // Narrow to critical only
    await userEvent.selectOptions(screen.getByLabelText(/severity/i), 'critical');

    // Wait for the minor-severity row to disappear
    await screen.findByText('Broken magic');
    expect(screen.queryByText('Typo')).toBeNull();

    // The API was called with the critical-filter path
    const calls = apiFn.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c === '/universes/U1/issues?severity=critical&resolved=false')).toBe(true);
  });

  it('opens the IssueEditor dialog when "New issue" is clicked', async () => {
    vi.mocked(api).mockImplementation(async (path?: string) => {
      if (path?.startsWith('/universes/U1/issues')) return [];
      return undefined;
    });

    renderAt('/universes/U1/issues');

    await userEvent.click(await screen.findByRole('button', { name: /new issue/i }));

    // Radix Dialog mounts with role="dialog"; title "New issue" is inside it.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    const dialogHeading = screen.getAllByText(/new issue/i);
    expect(dialogHeading.length).toBeGreaterThan(0);
  });

  it('calls PATCH with resolved=true when the Resolve button is clicked on an open issue', async () => {
    const apiFn = vi.mocked(api);
    apiFn.mockImplementation(async (path?: string, init?: RequestInit) => {
      if (path?.startsWith('/universes/U1/issues') && init?.method === 'PATCH') {
        return mkIssue('i1', 'Broken magic', 'critical', true);
      }
      if (path?.startsWith('/universes/U1/issues')) {
        return [mkIssue('i1', 'Broken magic', 'critical', false)];
      }
      return undefined;
    });

    renderAt('/universes/U1/issues');

    await userEvent.click(await screen.findByRole('button', { name: /^resolve$/i }));

    // Assert PATCH was issued with resolved: true in the body
    const patchCall = apiFn.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].startsWith('/universes/U1/issues/i1') && (c[1] as RequestInit)?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body).toEqual({ resolved: true });
  });

  it('shows a filter-aware empty state when filters are applied and no rows match', async () => {
    vi.mocked(api).mockImplementation(async () => []);

    renderAt('/universes/U1/issues');

    await userEvent.selectOptions(await screen.findByLabelText(/severity/i), 'critical');

    expect(await screen.findByText(/no issues match/i)).toBeInTheDocument();
  });
});
