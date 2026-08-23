/**
 * Issue #48 Task 7 — proves the real path a user follows to run an audit on
 * their own Ollama server: UniverseSettings' AI Gap Auditor tab → the
 * "Ollama" provider option → useListModels('ollama') → GET
 * /llm/models?provider=ollama → a selectable model → Save persists it.
 *
 * This is deliberately an end-to-end interaction test, not a render smoke
 * test — it exists because a prior review found `useListModels`
 * (useAudits.ts) typed its `provider` param as `'anthropic' | 'openai'`
 * only, which meant the frontend could never even FORM a request for
 * 'ollama' even though the backend (llm-models.ts) had served it since
 * Task 6: "looks finished, does not work". A test that only renders the
 * component and checks it doesn't crash cannot catch that class of bug —
 * this one drives the actual selection and asserts on the actual network
 * call and the actual PATCH body, so removing any one of: the Ollama
 * <option>, its wiring to useListModels, or auditProvider flowing
 * unmodified into the Save patch, breaks a concrete assertion below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const UNIVERSE = {
  id: 'U1',
  userId: 'user-1',
  name: 'Middle Earth',
  description: 'Tolkien legendarium',
  entryTypes: ['concept', 'entity', 'location'],
  auditEnabled: true,
  // Blank slate: no provider saved yet. The test drives the SELECTION
  // itself rather than starting from a pre-selected 'ollama', so it also
  // covers the provider <option> actually being choosable.
  auditProvider: null,
  auditModel: null,
  createdAt: '',
  updatedAt: '',
};

const OLLAMA_CONNECTION = {
  provider: 'ollama' as const,
  baseUrl: 'http://localhost:11434',
  label: '',
  bodySuffix: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastValidatedAt: '2026-08-20T00:00:00.000Z',
};

const OLLAMA_MODELS_RESPONSE = {
  models: [{ id: 'qwen3:32b', hasPricing: false }],
  source: 'live' as const,
  fetchedAt: '2026-08-22T00:00:00.000Z',
};

function renderAiTab() {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/config' && method === 'GET') return { localMode: true } as never;
    if (path === '/universes/U1' && method === 'GET') return UNIVERSE as never;
    if (path === '/llm-keys' && method === 'GET') return [] as never;
    if (path === '/llm-connections/ollama' && method === 'GET') return OLLAMA_CONNECTION as never;
    if (path === '/llm/models?provider=ollama' && method === 'GET') return OLLAMA_MODELS_RESPONSE as never;
    if (path === '/universes/U1' && method === 'PATCH') {
      const body = JSON.parse(init!.body as string);
      return { ...UNIVERSE, ...body } as never;
    }
    throw new Error(`Unhandled api() call in this test: ${method} ${path}`);
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/universes/U1/settings?tab=ai-auditor']}>
        <Routes>
          <Route path="/universes/:id/settings" element={<UniverseSettings />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UniverseSettings AI-auditor — Ollama end-to-end (Issue #48 Task 7)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    // useInstanceConfig gates its /config fetch on an authenticated session
    // (Task 6 made /config require auth) — without this, localMode stays
    // `undefined`, the Ollama <option> never renders, and the test would
    // fail for the wrong reason (no session) rather than the one it's
    // actually pinning.
    useAuthStore.setState({ user: { id: 'user-1', email: 'a@b.com', displayName: 'A' } });
  });
  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('selecting Ollama fetches /llm/models?provider=ollama and offers its models, unfiltered by pricing', async () => {
    renderAiTab();

    const providerSelect = await screen.findByLabelText('Provider');
    // The Ollama <option> itself is conditionally rendered, gated on
    // `useInstanceConfig()` resolving `localMode: true` (a separate async
    // fetch from the universe load `findByLabelText` above already waited
    // on) — wait for the option to exist before selecting it, or a select
    // against a not-yet-rendered option silently no-ops instead of throwing.
    await screen.findByRole('option', { name: 'Ollama' });
    await userEvent.selectOptions(providerSelect, 'ollama');

    // The Ollama option must exist and be selectable in the first place —
    // userEvent.selectOptions above already throws if it doesn't, but this
    // makes the assertion explicit and independent of that side effect.
    expect((providerSelect as HTMLSelectElement).value).toBe('ollama');

    // The live request this whole path exists to prove reachable.
    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls.filter(([p]) => p === '/llm/models?provider=ollama');
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    // The model it returned is offered, selectable (not disabled — Ollama
    // models are pre-filtered to tools-capable ones by the backend), and
    // does NOT carry the anthropic/openai-only "no pricing" warning (Ollama
    // has no PRICING entries at all; that suffix would be permanently and
    // meaninglessly true for every local model otherwise).
    const modelOption = await screen.findByRole('option', { name: 'qwen3:32b' });
    expect((modelOption as HTMLOptionElement).disabled).toBe(false);
    expect(screen.queryByText(/⚠ no pricing/)).not.toBeInTheDocument();
  });

  it('Save persists the chosen Ollama provider and model in the PATCH body', async () => {
    renderAiTab();

    const providerSelect = await screen.findByLabelText('Provider');
    await screen.findByRole('option', { name: 'Ollama' });
    await userEvent.selectOptions(providerSelect, 'ollama');
    await screen.findByRole('option', { name: 'qwen3:32b' });

    const modelSelect = screen.getByLabelText('Model');
    await userEvent.selectOptions(modelSelect, 'qwen3:32b');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const patchCall = vi
        .mocked(api)
        .mock.calls.find(([p, init]) => p === '/universes/U1' && init?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall![1]!.body as string);
      // The load-bearing assertion: 'ollama' survives, unmodified, all the
      // way from the <select>'s onChange through to the PATCH body. Before
      // this task, `toDisplayableAuditProvider` silently rewrote a saved
      // 'ollama' to `null` here — this would have failed against that code.
      expect(body.auditProvider).toBe('ollama');
      expect(body.auditModel).toBe('qwen3:32b');
    });
  });
});
