/**
 * Phase 27 Plan 04 Task 3 — AuditCompletionBanner cost-unknown chip tests.
 *
 * Pins:
 *   - Test 1: when `run.costUnknown === true`, the literal string `cost
 *     unknown` renders inside an amber chip; `$0.0000` does NOT appear.
 *   - Test 2: when `run.costUnknown === false`, the existing cost rendering
 *     (`Cost: $X.XXXX`) is unchanged.
 *
 * Mocks useAuditRun + useEstimateAudit + useIssues + useUniverse at the
 * module boundary so we exercise the cost-rendering branch deterministically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../hooks/useAudits', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useAudits')>('../hooks/useAudits');
  return {
    ...actual,
    useAuditRun: vi.fn(),
    useEstimateAudit: vi.fn(),
  };
});
vi.mock('../hooks/useUniverse', () => ({
  useUniverse: vi.fn(),
}));
vi.mock('../hooks/useIssues', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useIssues')>('../hooks/useIssues');
  return {
    ...actual,
    useIssues: vi.fn(),
  };
});

import { useAuditRun, useEstimateAudit } from '../hooks/useAudits';
import { useUniverse } from '../hooks/useUniverse';
import { useIssues } from '../hooks/useIssues';
import { AuditCompletionBanner } from './AuditCompletionBanner';

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const BASE_RUN = {
  id: '00000000-0000-0000-0000-000000000001',
  universeId: '00000000-0000-0000-0000-000000000099',
  scope: 'universe' as const,
  scopeEntryId: null,
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  status: 'succeeded' as const,
  promptTokens: 100,
  completionTokens: 50,
  cachedTokens: 0,
  toolCallCount: 0,
  costUsd: '0.0042',
  costUnknown: false,
  error: null,
  startedAt: '2026-05-26T00:00:00.000Z',
  finishedAt: '2026-05-26T00:01:00.000Z',
  suggestionCount: 3,
};

describe('AuditCompletionBanner — Phase 27 D-06 cost_unknown chip', () => {
  beforeEach(() => {
    vi.mocked(useEstimateAudit).mockReturnValue({ data: undefined } as never);
    vi.mocked(useUniverse).mockReturnValue({ data: { auditEnabled: true } } as never);
    vi.mocked(useIssues).mockReturnValue({ data: [] } as never);
  });

  it('Test 1 — renders "cost unknown" amber chip and HIDES the dollar amount when costUnknown===true', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: { ...BASE_RUN, costUnknown: true, costUsd: '0.0000' },
    } as never);

    render(
      <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
      { wrapper: Wrapper },
    );

    // "cost unknown" copy is rendered.
    const chip = screen.getByText(/cost unknown/i);
    expect(chip).toBeInTheDocument();
    // Lowercase, no $ sign — the chip text must not contain "$".
    expect(chip.textContent).not.toMatch(/\$/);
    // Amber palette is applied — at least one ancestor element has the amber
    // text class.
    expect(chip.className).toMatch(/text-amber-700/);

    // The literal "Cost: $" string must NOT appear.
    expect(screen.queryByText(/Cost: \$/)).not.toBeInTheDocument();
  });

  it('Test 2 — renders Cost: $X.XXXX when costUnknown===false (existing behavior preserved)', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: { ...BASE_RUN, costUnknown: false, costUsd: '0.0123' },
    } as never);

    render(
      <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText(/Cost: \$0\.0123/)).toBeInTheDocument();
    // No "cost unknown" chip when the flag is false.
    expect(screen.queryByText(/cost unknown/i)).not.toBeInTheDocument();
  });

  it('Test 2b — treats undefined costUnknown as false (backward-compat)', () => {
    // Older cached payloads may lack `costUnknown` entirely.
    const { costUnknown: _omit, ...legacyRun } = BASE_RUN;
    void _omit;
    vi.mocked(useAuditRun).mockReturnValue({
      data: { ...legacyRun, costUsd: '0.0042' },
    } as never);

    render(
      <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/Cost: \$0\.0042/)).toBeInTheDocument();
    expect(screen.queryByText(/cost unknown/i)).not.toBeInTheDocument();
  });
});

describe('AuditCompletionBanner — context truncation', () => {
  beforeEach(() => {
    vi.mocked(useEstimateAudit).mockReturnValue({ data: undefined } as never);
    vi.mocked(useUniverse).mockReturnValue({ data: { auditEnabled: true } } as never);
    vi.mocked(useIssues).mockReturnValue({ data: [] } as never);
  });

  it('tells the user to narrow the audit scope instead of diagnosing model availability', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: {
        ...BASE_RUN,
        status: 'failed',
        error: 'context_truncated',
        suggestionCount: 0,
      },
    } as never);

    render(
      <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
      { wrapper: Wrapper },
    );

    expect(
      screen.getByText(
        /The audit scope is too large for the selected model's context window\. Try a narrower audit scope\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not available on this account/i)).not.toBeInTheDocument();
  });
});
