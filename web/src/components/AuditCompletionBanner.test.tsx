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

/**
 * #50 Task 9 — whether `text` implies something about the OWNER's/
 * administrator's key state (existence, validity, deletion, revocation),
 * which the server deliberately never discloses to the recipient (see
 * useLlmShares.ts's file header: "a recipient who could tell one owner-side
 * failure from another has been handed an oracle for the administrator
 * roster").
 *
 * This is prose, not a secret value, so it cannot be a literal poison-value
 * scan the way SharedLlmConnections.test.tsx's `expectNoOwnerOrKeyMaterial`
 * is. A first version of this check used two regexes
 * (`/administrator'?s key/i` and a same-clause deleted/revoked proximity
 * scan) that a review caught as PERMEABLE: they miss "the owner's key is
 * invalid", "the owner's API key has expired", and "the administrator...
 * deleted their key" — the most natural ways this copy could regress. The
 * fix strips the legitimate copy's OWN mention of the recipient's key ("a
 * personal API key") before scanning, which is what makes a broad
 * bidirectional proximity match usable without colliding with the real
 * sentence ("Contact the administrator... add a personal API key") — see
 * the LEAK CHECK tests below, which prove this catches each phrasing a
 * reviewer supplied, and the two real-copy tests above, which prove it does
 * NOT fire on the actual banner text.
 */
function impliesOwnerKeyState(rawText: string): boolean {
  // The only place "key" legitimately sits near "administrator" in this
  // banner's copy is the recipient's OWN key ("add a personal API key") —
  // strip that phrase first so the proximity scan below has nothing left to
  // false-positive on.
  const text = rawText.replace(/\b(a |your )?personal\s+(api\s+)?key\b/gi, '');
  const subject = '(administrator|owner|admin)';
  const object = '(key|credential)';
  const verb = '(deleted|revoked|invalid|expired|disabled)';
  if (new RegExp(`${subject}'s\\s+(\\w+\\s+)?${object}`, 'i').test(text)) return true;
  if (new RegExp(`${subject}[^.]{0,80}\\btheir\\s+${object}\\b`, 'i').test(text)) return true;
  if (new RegExp(`${subject}[^.]{0,60}${object}[^.]{0,20}${verb}`, 'i').test(text)) return true;
  if (new RegExp(`${verb}[^.]{0,20}${object}[^.]{0,60}${subject}`, 'i').test(text)) return true;
  if (new RegExp(`${object}[^.]{0,60}${subject}[^.]{0,20}${verb}`, 'i').test(text)) return true;
  return false;
}

function expectNoOwnerKeyStateImplication() {
  const text = document.body.textContent ?? '';
  expect(impliesOwnerKeyState(text)).toBe(false);
}

describe('AuditCompletionBanner — #50 Task 9 shared-connection error copy', () => {
  beforeEach(() => {
    vi.mocked(useEstimateAudit).mockReturnValue({ data: undefined } as never);
    vi.mocked(useUniverse).mockReturnValue({ data: { auditEnabled: true } } as never);
    vi.mocked(useIssues).mockReturnValue({ data: [] } as never);
  });

  it("shared_access_revoked tells the recipient their access ended, not that the owner's key failed", () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: {
        ...BASE_RUN,
        status: 'failed',
        error: 'shared_access_revoked',
        suggestionCount: 0,
      },
    } as never);

    render(
      <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
      { wrapper: Wrapper },
    );

    expect(
      screen.getByText(/Your access to this shared connection has ended\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Contact the administrator/i)).toBeInTheDocument();
    expect(screen.getByText(/personal API key in Settings/i)).toBeInTheDocument();
    // Must not fall through to the generic fallback copy.
    expect(screen.queryByText(/An unexpected error occurred/)).not.toBeInTheDocument();
    // Must not imply anything about the OWNER's key state — the server
    // deliberately never discloses that to the recipient. Leak-simulated
    // below (LEAK CHECK tests): this check is shown to actually catch the
    // phrasings a real regression would produce, not just to pass on this
    // copy.
    expectNoOwnerKeyStateImplication();
  });

  it('shared_credential_unavailable tells the recipient the connection is unusable right now, without diagnosing why', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: {
        ...BASE_RUN,
        status: 'failed',
        error: 'shared_credential_unavailable',
        suggestionCount: 0,
      },
    } as never);

    render(
      <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
      { wrapper: Wrapper },
    );

    expect(
      screen.getByText(/the shared connection is not currently usable/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Contact the administrator/i)).toBeInTheDocument();
    expect(screen.getByText(/personal API key in Settings/i)).toBeInTheDocument();
    expect(screen.queryByText(/An unexpected error occurred/)).not.toBeInTheDocument();
    expectNoOwnerKeyStateImplication();
  });
});

describe('AuditCompletionBanner — #50 Task 9 leak simulation for the owner-key-state guard', () => {
  // Reviewer-supplied realistic leak phrasings the first version of this
  // guard (see impliesOwnerKeyState's doc) missed. Each must be shown to
  // actually TRIP the guard — a poison-text scan that never trips is the
  // same class of bug as the `'iv'` substring matching `"source":"live"`.
  const LEAK_PHRASINGS = [
    "The administrator's key was revoked.",
    "The connection owner's key is invalid.",
    "The owner's API key has expired.",
    'The administrator who shared this deleted their key.',
  ];

  it.each(LEAK_PHRASINGS)('LEAK CHECK: catches %j', (phrase) => {
    document.body.innerHTML = `<div>${phrase}</div>`;
    expect(() => expectNoOwnerKeyStateImplication()).toThrow();
    document.body.innerHTML = '';
  });

  it('does not false-positive on the actual shared-connection remedy copy', () => {
    document.body.innerHTML =
      '<div>Contact the administrator who shared it, or add a personal API key in Settings \u2192 LLM keys.</div>';
    expect(() => expectNoOwnerKeyStateImplication()).not.toThrow();
    document.body.innerHTML = '';
  });
});
