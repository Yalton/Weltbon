/**
 * Phase 27 Plan 04 Task 2 — UniverseSettings AI-auditor tab tests.
 *
 * Pins (Phase 27 D-05 + D-08):
 *   - Test 1: live-driven options — when useListModels returns a 2-model list
 *     (one priced, one unpriced), the dropdown renders both as <option>
 *     elements and the unpriced one's text ends with ` ⚠ no pricing`.
 *   - Test 2: D-08 fallback chain — when RECOMMENDED_CHEAP_MODEL is NOT in
 *     the live list, the default selection is the first live entry.
 *   - Test 3: empty live list — when models is `[]`, the dropdown is
 *     replaced by "No models available for the selected provider." inline
 *     copy (CONTEXT D-08 chain step 3).
 *   - Test 4: PRICING fallback path — when source='pricing_fallback' but
 *     models are populated and all hasPricing=true, the dropdown still
 *     renders and no warning suffix appears.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, api: vi.fn() };
});
import { api } from '../api/client';
import { UniverseSettings } from './UniverseSettings';

const UNIVERSE = {
  id: 'U1',
  userId: 'user-1',
  name: 'Middle Earth',
  description: 'Tolkien legendarium',
  entryTypes: ['concept', 'entity', 'location'],
  auditEnabled: true,
  auditProvider: 'anthropic',
  auditModel: null,
  createdAt: '',
  updatedAt: '',
};

const LLM_KEYS = [
  {
    id: 'llmkey-1',
    provider: 'anthropic',
    bodySuffix: 'XYZ4',
    label: 'work',
    createdAt: '',
    lastValidatedAt: '',
    totalSpentUsd: '0.0000',
    costUnknownCount: 0,
  },
];

function renderAiTab(modelsResponse: unknown, universePatch: Partial<typeof UNIVERSE> = {}) {
  const merged = { ...UNIVERSE, ...universePatch };
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/universes/U1' && method === 'GET') return merged as never;
    if (path === '/llm-keys' && method === 'GET') return LLM_KEYS as never;
    if (path.startsWith('/llm/models') && method === 'GET') {
      if (modelsResponse instanceof Error) throw modelsResponse;
      return modelsResponse as never;
    }
    return null as never;
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/U1/settings?tab=ai-auditor`]}>
        <Routes>
          <Route path="/universes/:id/settings" element={<UniverseSettings />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UniverseSettings AI-auditor — Phase 27 D-05 + D-08 live model dropdown', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('Test 1 — renders live options with `⚠ no pricing` suffix for unpriced entries', async () => {
    renderAiTab({
      models: [
        { id: 'claude-haiku-4-5-20251001', hasPricing: true, pricing: { id: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 } },
        { id: 'claude-future-snapshot-9', hasPricing: false },
      ],
      source: 'live',
      fetchedAt: '2026-05-26T00:00:00.000Z',
    });

    // Wait for the universe to load (Model dropdown becomes enabled when
    // auditProvider is set + auditEnabled=true).
    await waitFor(() => {
      expect(screen.getByLabelText('Model')).toBeInTheDocument();
    });

    // Wait for the live-models query to settle.
    await waitFor(() => {
      const opts = screen.getAllByRole('option');
      // Provider dropdown also has options ("Select provider", "Anthropic",
      // "OpenAI") — filter to the model dropdown's options by checking for
      // the model id.
      expect(opts.some((o) => o.textContent === 'claude-haiku-4-5-20251001')).toBe(true);
    });

    const unpricedOption = screen.getByRole('option', {
      name: /claude-future-snapshot-9.*⚠ no pricing/,
    });
    expect(unpricedOption).toBeInTheDocument();

    const pricedOption = screen.getByRole('option', { name: /^claude-haiku-4-5-20251001$/ });
    expect(pricedOption).toBeInTheDocument();
    // The priced option must NOT carry the warning suffix.
    expect(pricedOption.textContent).not.toMatch(/no pricing/);
  });

  it('Test 2 — D-08 fallback chain selects live[0] when RECOMMENDED_CHEAP_MODEL is absent from live list', async () => {
    renderAiTab(
      {
        models: [
          { id: 'unknown-snapshot-A', hasPricing: false },
          { id: 'unknown-snapshot-B', hasPricing: false },
        ],
        source: 'live',
        fetchedAt: '2026-05-26T00:00:00.000Z',
      },
      // Universe has auditProvider set but no auditModel yet — fallback chain
      // fires.
      { auditModel: null },
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Model')).toBeInTheDocument();
    });
    await waitFor(() => {
      // First model from live list is the default.
      const select = screen.getByLabelText('Model') as HTMLSelectElement;
      expect(select.value).toBe('unknown-snapshot-A');
    });

    // Both options carry the warning suffix.
    const optA = screen.getByRole('option', { name: /unknown-snapshot-A.*⚠ no pricing/ });
    const optB = screen.getByRole('option', { name: /unknown-snapshot-B.*⚠ no pricing/ });
    expect(optA).toBeInTheDocument();
    expect(optB).toBeInTheDocument();
  });

  it('Test 3 — empty live list renders "No models available" inline message', async () => {
    renderAiTab({
      models: [],
      source: 'pricing_fallback',
      fetchedAt: '2026-05-26T00:00:00.000Z',
    });

    await waitFor(() => {
      expect(
        screen.getByText(/no models available for the selected provider/i),
      ).toBeInTheDocument();
    });

    // The select element must not be in the document for the model picker
    // (provider select is still present; identify by label "Model").
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('Test 4 — pricing_fallback with priced models renders options without warning suffix', async () => {
    renderAiTab({
      models: [
        { id: 'claude-haiku-4-5-20251001', hasPricing: true, pricing: { id: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 } },
        { id: 'claude-sonnet-4-6', hasPricing: true, pricing: { id: 'claude-sonnet-4-6', inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 } },
      ],
      source: 'pricing_fallback',
      fetchedAt: '2026-05-26T00:00:00.000Z',
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Model')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /^claude-haiku-4-5-20251001$/ })).toBeInTheDocument();
    });

    // No option should carry the warning suffix.
    expect(screen.queryByText(/⚠ no pricing/)).not.toBeInTheDocument();
  });

  it('Test 5 — D-08 fallback chain picks RECOMMENDED_CHEAP_MODEL when present in live list', async () => {
    renderAiTab(
      {
        models: [
          { id: 'claude-opus-4-7', hasPricing: true, pricing: { id: 'claude-opus-4-7', inputUsdPer1M: 5.0, outputUsdPer1M: 25.0 } },
          { id: 'claude-haiku-4-5-20251001', hasPricing: true, pricing: { id: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 } },
          { id: 'claude-sonnet-4-6', hasPricing: true, pricing: { id: 'claude-sonnet-4-6', inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 } },
        ],
        source: 'live',
        fetchedAt: '2026-05-26T00:00:00.000Z',
      },
      { auditModel: null },
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Model')).toBeInTheDocument();
    });
    // D-08 chain prefers RECOMMENDED_CHEAP_MODEL.anthropic = 'claude-haiku-4-5-20251001'.
    await waitFor(() => {
      const select = screen.getByLabelText('Model') as HTMLSelectElement;
      expect(select.value).toBe('claude-haiku-4-5-20251001');
    });
  });
});

describe('UniverseSettings AI-auditor — useListModels integration smoke', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('issues GET /llm/models?provider=anthropic on the AI tab', async () => {
    renderAiTab({
      models: [
        { id: 'claude-haiku-4-5-20251001', hasPricing: true, pricing: { id: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 } },
      ],
      source: 'live',
      fetchedAt: '2026-05-26T00:00:00.000Z',
    });

    await waitFor(() => {
      const modelsCalls = vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith('/llm/models'));
      expect(modelsCalls.length).toBeGreaterThanOrEqual(1);
      expect(modelsCalls[0][0]).toBe('/llm/models?provider=anthropic');
    });
  });
});

// Avoid unused-import warnings if userEvent is not consumed.
void userEvent;
