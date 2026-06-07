/**
 * Phase 27 follow-up — automated tests for the unpriced-model UI affordances
 * in UniverseSettings (D-05 badge, D-08 default-selection fallback chain).
 *
 * All data-layer hooks are mocked; no real API key or network is required.
 *
 * Coverage:
 *   1a. All live model IDs render as <option> elements in the model dropdown
 *       (more than the PRICING-only set).
 *   1b. The unpriced model's option shows the "⚠ no pricing" suffix.
 *   1c. D-08 fallback: RECOMMENDED_CHEAP_MODEL is auto-selected when it is
 *       present in the live list (and auditModel starts empty).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ─── Mock the api client (all hooks ultimately call api()) ────────────────────
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, api: vi.fn() };
});

// ─── Mock useListModels from useAudits ────────────────────────────────────────
// We mock at the module level so the hook never calls the network.
vi.mock('../hooks/useAudits', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useAudits')>('../hooks/useAudits');
  return { ...actual, useListModels: vi.fn() };
});

// ─── Mock useLlmKeys so the provider dropdowns show keys present ──────────────
vi.mock('../hooks/useLlmKeys', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useLlmKeys')>('../hooks/useLlmKeys');
  return { ...actual, useLlmKeys: vi.fn() };
});

import { api } from '../api/client';
import { useListModels } from '../hooks/useAudits';
import { useLlmKeys } from '../hooks/useLlmKeys';
import type { ModelsResponse } from '../hooks/useAudits';
import { RECOMMENDED_CHEAP_MODEL } from '../data/pricing';
import { UniverseSettings } from './UniverseSettings';

// ─── Fixture data ─────────────────────────────────────────────────────────────

const UNIVERSE = {
  id: 'U1',
  userId: 'user-1',
  name: 'Middle Earth',
  description: 'Tolkien legendarium',
  entryTypes: ['concept', 'entity'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  auditEnabled: true,
  auditProvider: 'anthropic' as const,
  auditModel: '', // empty so D-08 default-selection fires
};

/**
 * Live catalog: 4 Anthropic models where one (claude-new-20260101) has no
 * PRICING entry, so hasPricing=false. RECOMMENDED_CHEAP_MODEL.anthropic IS
 * present, so D-08 should select it.
 */
const ANTHROPIC_MODELS_RESPONSE: ModelsResponse = {
  models: [
    { id: RECOMMENDED_CHEAP_MODEL.anthropic, hasPricing: true },
    { id: 'claude-sonnet-4-6', hasPricing: true },
    { id: 'claude-opus-4-7', hasPricing: true },
    { id: 'claude-new-20260101', hasPricing: false },
  ],
  source: 'live',
  fetchedAt: '2026-06-06T00:00:00Z',
};

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderOnAiTab(universeOverrides: Partial<typeof UNIVERSE> = {}) {
  const universe = { ...UNIVERSE, ...universeOverrides };
  // Override the api mock to return the specific universe fixture for this render.
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (typeof path === 'string' && path.includes('/universes/U1')) {
      return universe as never;
    }
    return [] as never;
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/U1/settings?tab=ai-auditor`]}>
        <Routes>
          <Route path="/universes/:id/settings" element={<UniverseSettings />} />
          <Route path="/settings/llm" element={<p>LLM settings</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('UniverseSettings — unpriced model dropdown (Phase 27 D-05 / D-08)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();

    // useLlmKeys: anthropic key present so provider option is enabled.
    vi.mocked(useLlmKeys).mockReturnValue({
      data: [
        {
          id: 'key-1',
          provider: 'anthropic',
          bodySuffix: 'XXXX',
          label: 'My key',
          createdAt: '2026-01-01T00:00:00Z',
          lastValidatedAt: null,
          totalSpentUsd: '0.0000',
          unknownCount: 0,
        },
      ],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmKeys>);

    // useListModels: return the 4-model live catalog for anthropic.
    vi.mocked(useListModels).mockImplementation((provider) => {
      if (provider === 'anthropic') {
        return {
          data: ANTHROPIC_MODELS_RESPONSE,
          isPending: false,
          isLoading: false,
          isFetching: false,
          isSuccess: true,
          isError: false,
          error: null,
        } as ReturnType<typeof useListModels>;
      }
      return {
        data: undefined,
        isPending: false,
        isLoading: false,
        isFetching: false,
        isSuccess: false,
        isError: false,
        error: null,
      } as ReturnType<typeof useListModels>;
    });
  });

  it('1a: all live model IDs render as <option> elements in the model dropdown', async () => {
    renderOnAiTab();

    // Wait for the universe to load (heading appears).
    await screen.findByRole('heading', { name: /AI Gap Auditor/i });

    // All 4 live models should appear as options.
    for (const m of ANTHROPIC_MODELS_RESPONSE.models) {
      const options = await screen.findAllByRole('option');
      const optionTexts = options.map((o) => o.textContent ?? '');
      expect(optionTexts.some((t) => t.includes(m.id))).toBe(true);
    }

    // The PRICING set only has 3 Anthropic models; the dropdown now has 4.
    const modelSelect = screen.getByRole('combobox', { name: /model/i });
    const optionElements = Array.from(modelSelect.querySelectorAll('option')).filter(
      (o) => (o as HTMLOptionElement).value !== '',
    );
    expect(optionElements.length).toBe(4);
  });

  it('1b: the unpriced model option shows "⚠ no pricing" suffix', async () => {
    renderOnAiTab();

    await screen.findByRole('heading', { name: /AI Gap Auditor/i });

    // The option for claude-new-20260101 must contain the warning suffix.
    const options = await screen.findAllByRole('option');
    const unpricedOption = options.find((o) => o.textContent?.includes('claude-new-20260101'));
    expect(unpricedOption).toBeDefined();
    expect(unpricedOption!.textContent).toMatch(/⚠ no pricing/);
  });

  it('1b: priced model options do NOT show "⚠ no pricing"', async () => {
    renderOnAiTab();

    await screen.findByRole('heading', { name: /AI Gap Auditor/i });

    const options = await screen.findAllByRole('option');
    const pricedOption = options.find((o) =>
      o.textContent?.includes(RECOMMENDED_CHEAP_MODEL.anthropic) &&
      !o.textContent?.includes('no pricing'),
    );
    expect(pricedOption).toBeDefined();
  });

  it('1c: D-08 — RECOMMENDED_CHEAP_MODEL is auto-selected when it is in the live list', async () => {
    // auditModel starts empty; the D-08 useEffect should fire and pick
    // RECOMMENDED_CHEAP_MODEL.anthropic since it is in the live list.
    renderOnAiTab({ auditModel: '' });

    await screen.findByRole('heading', { name: /AI Gap Auditor/i });

    const modelSelect = screen.getByRole('combobox', { name: /model/i }) as HTMLSelectElement;

    await waitFor(() => {
      expect(modelSelect.value).toBe(RECOMMENDED_CHEAP_MODEL.anthropic);
    });
  });

  it('1c: D-08 — falls back to live[0] when RECOMMENDED_CHEAP_MODEL is NOT in the live list', async () => {
    // Override catalog to exclude the recommended model.
    const withoutRecommended: ModelsResponse = {
      models: [
        { id: 'claude-new-20260101', hasPricing: false },
        { id: 'claude-sonnet-4-6', hasPricing: true },
      ],
      source: 'live',
      fetchedAt: '2026-06-06T00:00:00Z',
    };
    vi.mocked(useListModels).mockImplementation((provider) => {
      if (provider === 'anthropic') {
        return {
          data: withoutRecommended,
          isPending: false,
          isLoading: false,
          isFetching: false,
          isSuccess: true,
          isError: false,
          error: null,
        } as ReturnType<typeof useListModels>;
      }
      return {
        data: undefined,
        isPending: false,
        isLoading: false,
        isFetching: false,
        isSuccess: false,
        isError: false,
        error: null,
      } as ReturnType<typeof useListModels>;
    });

    renderOnAiTab({ auditModel: '' });

    await screen.findByRole('heading', { name: /AI Gap Auditor/i });

    const modelSelect = screen.getByRole('combobox', { name: /model/i }) as HTMLSelectElement;

    await waitFor(() => {
      // live[0] is 'claude-new-20260101' when recommended is absent.
      expect(modelSelect.value).toBe('claude-new-20260101');
    });
  });

  it('1b: D-05 — selecting the unpriced model shows the amber "no pricing" chip below the dropdown', async () => {
    // Start with the unpriced model already selected.
    renderOnAiTab({ auditModel: 'claude-new-20260101' });

    await screen.findByRole('heading', { name: /AI Gap Auditor/i });

    // The amber chip should appear: "⚠ no pricing — runs will be marked as cost unknown"
    const chip = await screen.findByText(/no pricing — runs will be marked as cost unknown/);
    expect(chip).toBeInTheDocument();
  });

  it('1b: D-05 chip is absent when the selected model has pricing', async () => {
    renderOnAiTab({ auditModel: RECOMMENDED_CHEAP_MODEL.anthropic });

    await screen.findByRole('heading', { name: /AI Gap Auditor/i });

    expect(
      screen.queryByText(/no pricing — runs will be marked as cost unknown/),
    ).toBeNull();
  });

  it('selecting the unpriced model via the dropdown shows the amber chip', async () => {
    const user = userEvent.setup();
    renderOnAiTab({ auditModel: RECOMMENDED_CHEAP_MODEL.anthropic });

    await screen.findByRole('heading', { name: /AI Gap Auditor/i });

    const modelSelect = screen.getByRole('combobox', { name: /model/i });
    await user.selectOptions(modelSelect, 'claude-new-20260101');

    expect(
      await screen.findByText(/no pricing — runs will be marked as cost unknown/),
    ).toBeInTheDocument();
  });
});
