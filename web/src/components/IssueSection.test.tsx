import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { IssueSection } from './IssueSection';
import type { Severity } from '../hooks/useIssues';

// Phase 26 Plan 06 — IssueSection now mounts <AuditCostDialog> which calls
// useNavigate(); a MemoryRouter is required even when the dialog is closed.
function renderSection(props: Parameters<typeof IssueSection>[0]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IssueSection {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('IssueSection', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders the heading with issue count and each issue row', () => {
    renderSection({
      universeId: 'U1',
      entryId: 'E1',
      issues: [
        { id: 'i1', title: 'Magic inconsistency', severity: 'major' as Severity },
        { id: 'i2', title: 'Missing chapter', severity: 'critical' as Severity },
      ],
    });

    expect(screen.getByRole('heading', { name: /issues \(2\)/i })).toBeInTheDocument();
    expect(screen.getByText('Magic inconsistency')).toBeInTheDocument();
    expect(screen.getByText('Missing chapter')).toBeInTheDocument();
  });

  it('renders an empty-state message and a Flag issue button when there are no issues', () => {
    renderSection({ universeId: 'U1', entryId: 'E1', issues: [] });

    expect(screen.getByRole('heading', { name: /issues \(0\)/i })).toBeInTheDocument();
    expect(screen.getByText(/no open issues for this entry/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /flag issue/i })).toBeInTheDocument();
  });

  it('clicking Resolve PATCHes the issue with resolved=true', async () => {
    vi.mocked(api).mockImplementation(async (_path, _init) => {
      return { ok: true };
    });

    renderSection({
      universeId: 'U1',
      entryId: 'E1',
      issues: [{ id: 'i1', title: 'Typo', severity: 'minor' as Severity }],
    });

    await userEvent.click(screen.getByRole('button', { name: /^resolve$/i }));

    const patchCall = vi.mocked(api).mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0] === '/universes/U1/issues/i1' &&
        (c[1] as RequestInit)?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const body = JSON.parse(String((patchCall![1] as RequestInit).body));
    expect(body).toEqual({ resolved: true });
  });

  it('clicking Flag issue opens the IssueEditor dialog', async () => {
    renderSection({ universeId: 'U1', entryId: 'E1', issues: [] });

    await userEvent.click(screen.getByRole('button', { name: /flag issue/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // The dialog's title reads "New issue" when opened without an initialIssue
    expect(screen.getAllByText(/new issue/i).length).toBeGreaterThan(0);
  });
});
