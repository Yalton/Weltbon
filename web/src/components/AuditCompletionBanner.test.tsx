/**
 * Phase 27 follow-up — automated tests for AuditCompletionBanner
 * "cost unknown" affordance (D-06).
 *
 * Mocks useAuditRun, useEstimateAudit, useUniverse, useIssues so no real
 * API key or network is required.
 *
 * Coverage:
 *   2. When run.costUnknown=true the "cost unknown" chip renders and
 *      "$0.0000" does NOT appear.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../hooks/useAudits', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useAudits')>('../hooks/useAudits');
  return {
    ...actual,
    useAuditRun: vi.fn(),
    useEstimateAudit: vi.fn(),
  };
});

vi.mock('../hooks/useUniverse', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useUniverse')>('../hooks/useUniverse');
  return { ...actual, useUniverse: vi.fn() };
});

vi.mock('../hooks/useIssues', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useIssues')>('../hooks/useIssues');
  return { ...actual, useIssues: vi.fn() };
});

import { useAuditRun, useEstimateAudit } from '../hooks/useAudits';
import { useUniverse } from '../hooks/useUniverse';
import { useIssues } from '../hooks/useIssues';
import type { AuditRun } from '../hooks/useAudits';
import { AuditCompletionBanner } from './AuditCompletionBanner';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<AuditRun> = {}): AuditRun {
  return {
    id: 'run-1',
    universeId: 'U1',
    scope: 'universe',
    scopeEntryId: null,
    provider: 'anthropic',
    model: 'claude-new-20260101',
    status: 'succeeded',
    promptTokens: 1000,
    completionTokens: 200,
    cachedTokens: 0,
    toolCallCount: 1,
    costUsd: '0.0000',
    costUnknown: false,
    error: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date().toISOString(),
    suggestionCount: 3,
    analyzedEntries: 5,
    ...overrides,
  };
}

function renderBanner(props: { runId?: string; universeId?: string } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuditCompletionBanner
          universeId={props.universeId ?? 'U1'}
          runId={props.runId ?? 'run-1'}
          dismissible={true}
          onDismiss={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuditCompletionBanner — cost unknown chip (Phase 27 D-06)', () => {
  beforeEach(() => {
    // Default: universe has audit enabled.
    vi.mocked(useUniverse).mockReturnValue({
      data: {
        id: 'U1',
        userId: 'user-1',
        name: 'Middle Earth',
        description: '',
        entryTypes: [],
        createdAt: '',
        updatedAt: '',
        auditEnabled: true,
        auditProvider: 'anthropic',
        auditModel: 'claude-new-20260101',
      },
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useUniverse>);

    // Issues: empty by default.
    vi.mocked(useIssues).mockReturnValue({
      data: [],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useIssues>);

    // Estimate: not needed for cost-unknown runs.
    vi.mocked(useEstimateAudit).mockReturnValue({
      data: undefined,
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useEstimateAudit>);
  });

  it('2a: renders "cost unknown" chip when run.costUnknown is true', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: makeRun({ costUnknown: true, costUsd: '0.0000' }),
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditRun>);

    renderBanner();

    // The chip with text "cost unknown" must be present.
    expect(screen.getByText('cost unknown')).toBeInTheDocument();
  });

  it('2b: "$0.0000" does NOT render when run.costUnknown is true', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: makeRun({ costUnknown: true, costUsd: '0.0000' }),
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditRun>);

    renderBanner();

    // The "$0.0000" string must not appear at all.
    expect(screen.queryByText('$0.0000')).toBeNull();
  });

  it('2c: renders the cost amount normally when run.costUnknown is false', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: makeRun({ costUnknown: false, costUsd: '0.0042' }),
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditRun>);

    renderBanner();

    expect(screen.queryByText('cost unknown')).toBeNull();
    expect(screen.getByText(/\$0\.0042/)).toBeInTheDocument();
  });

  it('2d: chip is accessible via aria-label', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: makeRun({ costUnknown: true, costUsd: '0.0000' }),
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditRun>);

    renderBanner();

    // The aria-label on the chip provides screen-reader context.
    expect(
      screen.getByLabelText(/Cost unknown: this run used a model without published pricing/i),
    ).toBeInTheDocument();
  });

  it('renders nothing (null) when run data is undefined', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: true,
      isFetching: true,
      isSuccess: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditRun>);

    const { container } = renderBanner();
    expect(container.firstChild).toBeNull();
  });
});
