
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AuditHistoryRow } from '../types/audit';

vi.mock('../hooks/useAudits', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useAudits')>('../hooks/useAudits');
  return {
    ...actual,
    useAuditHistory: vi.fn(),
  };
});

import { useAuditHistory } from '../hooks/useAudits';
import { AuditHistoryTable } from './AuditHistoryTable';

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

function baseRow(overrides: Partial<AuditHistoryRow>): AuditHistoryRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    scope: 'universe',
    scopeEntryId: null,
    scopeEntryTitle: null,
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    status: 'succeeded',
    costUsd: '0.0042',
    costUnknown: false,
    startedAt: '2026-05-26T00:00:00.000Z',
    finishedAt: '2026-05-26T00:01:00.000Z',
    suggestionsByCategory: {},
    analyzedEntries: 5,
    totalEntries: 5,
    ...overrides,
  };
}

function renderWithRows(rows: AuditHistoryRow[]) {
  vi.mocked(useAuditHistory).mockReturnValue({
    data: { rows, total: rows.length, hasMore: false },
    isPending: false,
    error: null,
  } as never);
  return render(<AuditHistoryTable universeId="U1" />, { wrapper: Wrapper });
}

describe('AuditHistoryTable — D-06 cost_unknown chip in cost cell', () => {
  beforeEach(() => {
    vi.mocked(useAuditHistory).mockReset();
  });

  it('Test 3 — costUnknown=true renders amber chip, NOT $0.0000 or', () => {
    renderWithRows([
      baseRow({
        id: 'aaaaaaaa-0000-0000-0000-000000000001',
        costUnknown: true,
        costUsd: '0.0000',
      }),
    ]);

    const chip = screen.getByText(/cost unknown/i);
    expect(chip).toBeInTheDocument();
    expect(chip.className).toMatch(/text-amber-700/);
    // The cell must not render the dollar amount or the em-dash placeholder
    // for this row.
    expect(screen.queryByText(/\$0\.0000/)).not.toBeInTheDocument();
  });

  it('Test 4 — costUnknown=false + status=failed + costUsd=0.0000 still renders the em-dash', () => {
    renderWithRows([
      baseRow({
        id: 'bbbbbbbb-0000-0000-0000-000000000002',
        costUnknown: false,
        status: 'failed',
        costUsd: '0.0000',
      }),
    ]);

    // Both the cost cell (failed-zero) and the findings cell (no findings)
    // render "—" for this row; assert at least one (the cost cell). The
    // important assertion is the absence of the cost-unknown chip and the
    // absence of a dollar amount.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/cost unknown/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('Test 5 — costUnknown=false + costUsd=0.0123 renders $0.0123 unchanged', () => {
    renderWithRows([
      baseRow({
        id: 'cccccccc-0000-0000-0000-000000000003',
        costUnknown: false,
        costUsd: '0.0123',
      }),
    ]);

    expect(screen.getByText('$0.0123')).toBeInTheDocument();
    expect(screen.queryByText(/cost unknown/i)).not.toBeInTheDocument();
  });
});

function expectNoOwnerOrKeyMaterial(poisonValues: string[]) {
  const text = document.body.textContent ?? '';
  const attributeValues: string[] = [];
  for (const el of Array.from(document.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) attributeValues.push(attr.value);
  }
  const haystack = `${text}\n${attributeValues.join('\n')}`;
  for (const value of poisonValues) {
    expect(haystack).not.toContain(value);
  }
}

describe('AuditHistoryTable — credentialSource display', () => {
  beforeEach(() => {
    vi.mocked(useAuditHistory).mockReset();
  });

  it("renders a compact 'Shared connection' label when credentialSource is 'shared'", () => {
    renderWithRows([
      baseRow({
        id: 'dddddddd-0000-0000-0000-000000000004',
        credentialSource: 'shared',
      }),
    ]);

    expect(screen.getByText(/shared connection/i)).toBeInTheDocument();
  });

  it("renders no label when credentialSource is 'own'", () => {
    renderWithRows([
      baseRow({
        id: 'eeeeeeee-0000-0000-0000-000000000005',
        credentialSource: 'own',
      }),
    ]);

    expect(screen.queryByText(/shared connection/i)).not.toBeInTheDocument();
  });

  it('renders no label and does not crash for older cached rows lacking credentialSource', () => {
    const { credentialSource: _omit, ...legacyRow } = baseRow({
      id: 'ffffffff-0000-0000-0000-000000000006',
      credentialSource: 'own',
    });
    void _omit;

    expect(() => renderWithRows([legacyRow as AuditHistoryRow])).not.toThrow();
    expect(screen.queryByText(/shared connection/i)).not.toBeInTheDocument();
  });

  it('renders no owner, grant id, or usage secret for a shared row (redaction check)', () => {
    // Poison: fields the server deliberately never sends for a shared row,
    // attached as extras the type does not declare. Nothing should render
    // them today; anything that starts to, will.
    const POISON = {
      ownerUserId: 'admin-user-uuid-1',
      ownerEmail: 'alice.admin@corp.example',
      grantId: 'grant-uuid-1',
      usageSecret: 'sk-ant-owner-plaintext-secret',
    };
    renderWithRows([
      { ...baseRow({ id: '00000000-0000-0000-0000-0000000000aa', credentialSource: 'shared' }), ...POISON } as AuditHistoryRow,
    ]);

    expectNoOwnerOrKeyMaterial(Object.values(POISON));
  });

  it('LEAK CHECK (text): the redaction check above fails when poison renders as text (proves it is not vacuous)', () => {
    renderWithRows([baseRow({ id: '00000000-0000-0000-0000-0000000000bb', credentialSource: 'shared' })]);
    // Appended as a standalone node (not via `innerHTML +=`, which persists
    // across tests sharing this file's jsdom document and would let one
    // LEAK CHECK's poison silently satisfy the next) so it can be removed
    // in `finally`, keeping this test's poison from contaminating the
    // attribute LEAK CHECK below.
    const poison = document.createElement('div');
    poison.textContent = 'text-leak-alice.admin@corp.example';
    document.body.appendChild(poison);
    try {
      expect(() => expectNoOwnerOrKeyMaterial(['text-leak-alice.admin@corp.example'])).toThrow();
    } finally {
      document.body.removeChild(poison);
    }
  });

  it('LEAK CHECK (attribute): the redaction check above fails when poison renders into an attribute, not just text', () => {
    // Review finding: `document.body.textContent` never contains attribute
    // values — that is a DOM-level fact, not a maybe. A text-only poison
    // proves nothing about the attribute-leak class, and this component
    // already builds an aria-label from row fields one line above the new
    // badge (`aria-label={... row.scope ... row.status}`), so "a field
    // rendered into an attribute" is a live path here, not a hypothetical.
    // A DIFFERENT poison value than the text LEAK CHECK above, so this
    // assertion cannot pass merely because the previous test's poison text
    // is still sitting in the DOM (RTL's `cleanup()` only unmounts tracked
    // `render()` containers, not nodes appended directly to `document.body`).
    renderWithRows([baseRow({ id: '00000000-0000-0000-0000-0000000000cc', credentialSource: 'shared' })]);
    const poison = document.createElement('div');
    poison.setAttribute('title', 'attr-leak-alice.admin@corp.example');
    poison.textContent = 'x';
    document.body.appendChild(poison);
    try {
      expect(() => expectNoOwnerOrKeyMaterial(['attr-leak-alice.admin@corp.example'])).toThrow();
    } finally {
      document.body.removeChild(poison);
    }
  });
});
