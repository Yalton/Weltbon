
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
import { AuditCompletionBanner, ERROR_COPY } from './AuditCompletionBanner';

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

describe('AuditCompletionBanner — D-06 cost_unknown chip', () => {
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

const REMEDY_SENTENCE = /add a personal API key in Settings\s*(?:\u2192|->)\s*LLM keys\.?/gi;

function impliesOwnerKeyState(rawText: string): boolean {
  // Strip only the shipped remedy clause — the one place this banner's copy
  // legitimately mentions a key near the word "administrator", and it is the
  // RECIPIENT's own key. Deliberately NOT a `personal ... key` noun strip:
  // that was the permeability the final review found.
  //
  // Measured, not assumed: with the verb list and orderings below, BOTH
  // shipped lines pass this guard unstripped — no verb sits near that phrase
  // today, so the strip is currently defensive rather than load-bearing. It
  // is kept because a copy edit that puts one there ("...if your key was
  // changed, add a personal API key in Settings → LLM keys") would otherwise
  // start failing the real-copy tests for no security reason. Being pinned to
  // a literal sentence is what makes keeping it safe: unlike a noun-phrase
  // strip, it cannot swallow a noun some OTHER sentence's match depends on.
  const text = rawText.replace(REMEDY_SENTENCE, '');
  const subject = '(administrator|owner|admin)';
  const object = '(key|credential)';
  const verb = '(deleted|revoked|removed|rotated|changed|invalid|expired|disabled)';
  // Possessive, allowing qualifiers between: "administrator's personal API key".
  if (new RegExp(`${subject}['\u2019]s\\s+(?:\\w+\\s+){0,3}${object}`, 'i').test(text)) return true;
  if (new RegExp(`${subject}[^.]{0,80}\\btheir\\s+(?:\\w+\\s+){0,3}${object}\\b`, 'i').test(text)) return true;
  if (new RegExp(`${subject}[^.]{0,60}${object}[^.]{0,20}${verb}`, 'i').test(text)) return true;
  if (new RegExp(`${subject}[^.]{0,60}${verb}[^.]{0,60}${object}`, 'i').test(text)) return true;
  if (new RegExp(`${verb}[^.]{0,20}${object}[^.]{0,60}${subject}`, 'i').test(text)) return true;
  if (new RegExp(`${object}[^.]{0,60}${subject}[^.]{0,20}${verb}`, 'i').test(text)) return true;
  if (new RegExp(`${object}[^.]{0,60}${verb}[^.]{0,60}${subject}`, 'i').test(text)) return true;
  return false;
}

function expectNoOwnerKeyStateImplication() {
  const text = document.body.textContent ?? '';
  expect(impliesOwnerKeyState(text)).toBe(false);
}

describe('AuditCompletionBanner — shared-connection error copy', () => {
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

describe('AuditCompletionBanner — leak simulation for the owner-key-state guard', () => {
  beforeEach(() => {
    vi.mocked(useEstimateAudit).mockReturnValue({ data: undefined } as never);
    vi.mocked(useUniverse).mockReturnValue({ data: { auditEnabled: true } } as never);
    vi.mocked(useIssues).mockReturnValue({ data: [] } as never);
  });


  const LEAK_PHRASINGS = [
    // Originally covered.
    "The administrator's key was revoked.",
    "The connection owner's key is invalid.",
    "The owner's API key has expired.",
    'The administrator who shared this deleted their key.',
    // Missed by the shipped guard until the final review.
    "The administrator's personal API key was revoked.",
    'The key it uses was revoked by the administrator.',
    'The shared credential was disabled by its owner.',
    "The administrator's personal key was deleted.",
    'The owner disabled their personal API key.',
    'This connection stopped working because the admin removed the credential.',
  ];

    it.each(LEAK_PHRASINGS)('LEAK CHECK: catches %j rendered by the real banner', (phrase) => {
    const original = ERROR_COPY.shared_access_revoked;
    vi.mocked(useAuditRun).mockReturnValue({
      data: { ...BASE_RUN, status: 'failed', error: 'shared_access_revoked', suggestionCount: 0 },
    } as never);
    try {
      ERROR_COPY.shared_access_revoked = phrase;
      render(
        <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
        { wrapper: Wrapper },
      );
      // The poison really is on screen — otherwise a throw below could come
      // from anything else the banner rendered.
      expect(screen.getByText(phrase)).toBeInTheDocument();
      expect(() => expectNoOwnerKeyStateImplication()).toThrow();
    } finally {
      ERROR_COPY.shared_access_revoked = original;
    }
  });

  it('does not false-positive on the actual shared-connection remedy copy', () => {
    // Unmodified table: the shipped copy, rendered by the shipped component.
    // Paired with the LEAK CHECKs above, this is what separates "the guard is
    // correct" from "the guard always throws".
    vi.mocked(useAuditRun).mockReturnValue({
      data: { ...BASE_RUN, status: 'failed', error: 'shared_access_revoked', suggestionCount: 0 },
    } as never);
    render(
      <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/personal API key in Settings/i)).toBeInTheDocument();
    expect(() => expectNoOwnerKeyStateImplication()).not.toThrow();
  });

  it('does not false-positive on the other shared-connection copy line', () => {
    vi.mocked(useAuditRun).mockReturnValue({
      data: { ...BASE_RUN, status: 'failed', error: 'shared_credential_unavailable', suggestionCount: 0 },
    } as never);
    render(
      <AuditCompletionBanner universeId={BASE_RUN.universeId} runId={BASE_RUN.id} />,
      { wrapper: Wrapper },
    );
    expect(screen.getByText(/the shared connection is not currently usable/i)).toBeInTheDocument();
    expect(() => expectNoOwnerKeyStateImplication()).not.toThrow();
  });
});
