/**
 * Phase 27 follow-up — automated tests for AuditHistoryTable
 * "cost unknown" affordance (D-06).
 *
 * Mocks useAuditHistory so no real API key or network is required.
 *
 * Coverage:
 *   3. When a row's costUnknown=true the "cost unknown" chip renders in the
 *      Cost cell instead of a dollar amount.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ─── Module mock ──────────────────────────────────────────────────────────────

vi.mock('../hooks/useAudits', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useAudits')>('../hooks/useAudits');
  return { ...actual, useAuditHistory: vi.fn() };
});

import { useAuditHistory } from '../hooks/useAudits';
import type { AuditHistoryRow } from '../hooks/useAudits';
import { AuditHistoryTable } from './AuditHistoryTable';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<AuditHistoryRow> = {}): AuditHistoryRow {
  return {
    id: 'row-1',
    scope: 'universe',
    scopeEntryId: null,
    scopeEntryTitle: null,
    provider: 'anthropic',
    model: 'claude-new-20260101',
    status: 'succeeded',
    costUsd: '0.0000',
    costUnknown: false,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    finishedAt: new Date().toISOString(),
    suggestionsByCategory: {},
    analyzedEntries: 5,
    totalEntries: 10,
    ...overrides,
  };
}

function renderTable(universeId = 'U1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuditHistoryTable universeId={universeId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuditHistoryTable — cost unknown chip (Phase 27 D-06)', () => {
  beforeEach(() => {
    vi.mocked(useAuditHistory).mockReset();
  });

  it('3a: renders "cost unknown" chip in the Cost cell when row.costUnknown is true', () => {
    vi.mocked(useAuditHistory).mockReturnValue({
      data: {
        rows: [makeRow({ costUnknown: true, costUsd: '0.0000' })],
        total: 1,
        hasMore: false,
      },
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditHistory>);

    renderTable();

    expect(screen.getByText('cost unknown')).toBeInTheDocument();
  });

  it('3b: a dollar amount does NOT appear in the Cost cell when costUnknown is true', () => {
    vi.mocked(useAuditHistory).mockReturnValue({
      data: {
        rows: [makeRow({ costUnknown: true, costUsd: '0.0000' })],
        total: 1,
        hasMore: false,
      },
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditHistory>);

    renderTable();

    expect(screen.queryByText('$0.0000')).toBeNull();
  });

  it('3c: the chip has the expected aria-label for screen readers', () => {
    vi.mocked(useAuditHistory).mockReturnValue({
      data: {
        rows: [makeRow({ costUnknown: true, costUsd: '0.0000' })],
        total: 1,
        hasMore: false,
      },
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditHistory>);

    renderTable();

    expect(
      screen.getByLabelText(/Cost unknown: this run used a model without published pricing/i),
    ).toBeInTheDocument();
  });

  it('3d: renders dollar amount normally when costUnknown is false', () => {
    vi.mocked(useAuditHistory).mockReturnValue({
      data: {
        rows: [makeRow({ costUnknown: false, costUsd: '0.0123' })],
        total: 1,
        hasMore: false,
      },
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditHistory>);

    renderTable();

    expect(screen.queryByText('cost unknown')).toBeNull();
    expect(screen.getByText('$0.0123')).toBeInTheDocument();
  });

  it('3e: multiple rows — each with costUnknown shows its own chip', () => {
    vi.mocked(useAuditHistory).mockReturnValue({
      data: {
        rows: [
          makeRow({ id: 'row-1', costUnknown: true, costUsd: '0.0000' }),
          makeRow({ id: 'row-2', costUnknown: true, costUsd: '0.0000' }),
        ],
        total: 2,
        hasMore: false,
      },
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditHistory>);

    renderTable();

    expect(screen.getAllByText('cost unknown')).toHaveLength(2);
  });

  it('3f: mixed rows — only the costUnknown row shows the chip', () => {
    vi.mocked(useAuditHistory).mockReturnValue({
      data: {
        rows: [
          makeRow({ id: 'row-1', costUnknown: true, costUsd: '0.0000' }),
          makeRow({ id: 'row-2', costUnknown: false, costUsd: '0.0050' }),
        ],
        total: 2,
        hasMore: false,
      },
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useAuditHistory>);

    renderTable();

    expect(screen.getAllByText('cost unknown')).toHaveLength(1);
    expect(screen.getByText('$0.0050')).toBeInTheDocument();
  });
});
