
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
import { useAuthStore } from '../store/auth';
import { UniverseSettings } from './UniverseSettings';
import type { SharedGrant } from '../hooks/useLlmShares';

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

function renderAiTab(
  modelsResponse: unknown,
  universePatch: Partial<typeof UNIVERSE> = {},
  opts: {
    sharedGrants?: SharedGrant[];
    llmKeys?: typeof LLM_KEYS;
    localMode?: boolean;
    ollamaConnection?: unknown;
  } = {},
) {
  const merged = { ...UNIVERSE, ...universePatch };
  const sharedGrants = opts.sharedGrants ?? [];
  const llmKeys = opts.llmKeys ?? LLM_KEYS;
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/universes/U1' && method === 'GET') return merged as never;
    if (path === '/llm-keys' && method === 'GET') return llmKeys as never;
    if (path === '/llm-shares' && method === 'GET') return { grants: sharedGrants } as never;
    if (path === '/config' && method === 'GET') return { localMode: opts.localMode ?? false } as never;
    if (path === '/llm-connections/ollama' && method === 'GET') {
      if (opts.ollamaConnection === undefined) throw new Error('no ollama connection configured');
      return opts.ollamaConnection as never;
    }
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

describe('UniverseSettings AI-auditor — D-05 + D-08 live model dropdown', () => {
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

const CONSENTED_ANTHROPIC_GRANT: SharedGrant = {
  id: 'grant-anthropic-1',
  provider: 'anthropic',
  status: 'active',
  createdAt: '2026-08-01T00:00:00.000Z',
  consentedAt: '2026-08-02T00:00:00.000Z',
  policyVersion: 'shared-llm-v1',
  disclosure: {
    providerName: 'Anthropic',
    credentialOwner: 'administrator-managed',
    contentLeavesThisInstance: true,
  },
  usage: {
    monthStart: '2026-08-01',
    settledUsd: '0.0000',
    reservedUsd: '0.0000',
    limitUsd: '1.0000',
    activeAudits: 0,
    maxConcurrentAudits: 1,
    completedAudits: 0,
    failedAudits: 0,
  },
};

const UNCONSENTED_OPENAI_GRANT: SharedGrant = {
  ...CONSENTED_ANTHROPIC_GRANT,
  id: 'grant-openai-1',
  provider: 'openai',
  consentedAt: null,
  disclosure: {
    providerName: 'OpenAI',
    credentialOwner: 'administrator-managed',
    contentLeavesThisInstance: true,
  },
};

const OLLAMA_CONNECTION = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  label: '',
  bodySuffix: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastValidatedAt: '2026-08-20T00:00:00.000Z',
};

describe('UniverseSettings AI-auditor — shared connection provider availability', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('personal-only: a configured personal key enables its provider with no shared wording', async () => {
    renderAiTab(
      { models: [], source: 'pricing_fallback', fetchedAt: '2026-05-26T00:00:00.000Z' },
      {},
      { sharedGrants: [] },
    );

    await screen.findByLabelText('Provider');

    // Anthropic has a personal key (default LLM_KEYS fixture) and no shared
    // grant — enabled, plain label, no "managed" wording.
    const anthropicOption = screen.getByRole('option', { name: 'Anthropic' });
    expect(anthropicOption).toBeEnabled();
    expect(anthropicOption.textContent).not.toMatch(/managed/i);

    // OpenAI has neither a personal key nor a shared grant — disabled, the
    // pre-existing "(no key configured)" copy, not the new consent copy.
    const openaiOption = screen.getByRole('option', { name: /OpenAI \(no key configured\)/ });
    expect(openaiOption).toBeDisabled();
    expect(screen.queryByText(/review consent in Settings/i)).not.toBeInTheDocument();
  });

  it('shared-consented + shared-unconsented: enables one provider, keeps the other gated behind consent', async () => {
    renderAiTab(
      {
        models: [
          {
            id: 'claude-haiku-4-5-20251001',
            hasPricing: true,
            pricing: { id: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 },
          },
        ],
        source: 'live',
        fetchedAt: '2026-05-26T00:00:00.000Z',
      },
      {},
      {
        // No personal key for either provider — only shared grants decide
        // availability here.
        llmKeys: [],
        sharedGrants: [CONSENTED_ANTHROPIC_GRANT, UNCONSENTED_OPENAI_GRANT],
      },
    );

    await screen.findByLabelText('Provider');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Anthropic.*managed/i })).toBeEnabled();
    });
    expect(screen.getByRole('option', { name: /OpenAI.*requires Settings consent/i })).toBeDisabled();
    expect(screen.getByText(/review consent in Settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Ollama.*managed/i })).not.toBeInTheDocument();

    // The default universe fixture's auditProvider is 'anthropic' (consented
    // shared), so the model route IS probed for it — the disabled-by-default
    // Loading state some earlier tests assert on is not what's under test
    // here; the live-model fetch settling is:
    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith('/llm/models'));
      expect(calls.some(([p]) => p === '/llm/models?provider=anthropic')).toBe(true);
    });
  });

  it('does not probe /llm/models for a provider with only an unconsented shared grant', async () => {
    renderAiTab(
      { models: [], source: 'pricing_fallback', fetchedAt: '2026-05-26T00:00:00.000Z' },
      // The universe's SAVED provider is the one gated behind consent.
      { auditProvider: 'openai' },
      { llmKeys: [], sharedGrants: [UNCONSENTED_OPENAI_GRANT] },
    );

    await screen.findByLabelText('Provider');
    // Give any (incorrect) fetch a chance to fire before asserting its absence.
    await new Promise((r) => setTimeout(r, 30));

    const modelsCalls = vi
      .mocked(api)
      .mock.calls.filter(([p]) => String(p).startsWith('/llm/models'));
    expect(modelsCalls).toHaveLength(0);
  });

  it('Ollama-local: local instance shows Ollama independent of shared grants, never "managed"', async () => {
    useAuthStore.setState({ user: { id: 'user-1', email: 'a@b.com', displayName: 'A' } });
    try {
      renderAiTab(
        {
          models: [
            {
              id: 'claude-haiku-4-5-20251001',
              hasPricing: true,
              pricing: { id: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 },
            },
          ],
          source: 'live',
          fetchedAt: '2026-05-26T00:00:00.000Z',
        },
        {},
        {
          localMode: true,
          ollamaConnection: OLLAMA_CONNECTION,
          // A shared grant on an unrelated provider must not leak "managed"
          // wording onto Ollama's option.
          sharedGrants: [CONSENTED_ANTHROPIC_GRANT],
        },
      );

      await screen.findByLabelText('Provider');
      const ollamaOption = await screen.findByRole('option', { name: 'Ollama' });
      expect(ollamaOption).toBeEnabled();
      expect(ollamaOption.textContent).not.toMatch(/managed/i);
      expect(screen.queryByRole('option', { name: /Ollama.*managed/i })).not.toBeInTheDocument();

      // The default fixture's auditProvider ('anthropic', consented) also
      // triggers a model-catalog fetch in the background — drain it before
      // the test ends so its resolution doesn't land as a post-test state
      // update (React act() warning) once this test's own assertions are done.
      await screen.findByRole('option', { name: 'claude-haiku-4-5-20251001' });
    } finally {
      useAuthStore.setState({ user: null });
    }
  });
});

// Avoid unused-import warnings if userEvent is not consumed.
void userEvent;
