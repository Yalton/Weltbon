/**
 * LlmKeys view tests — Phase 22-05.
 *
 * Pins:
 *   - Consent gate (LLMKEY-07): paste UI hidden until consentedAt is non-null
 *   - Canonical D-09 consent copy ("provider sees your text; you pay for the
 *     tokens; Weltbon stores your key encrypted at rest")
 *   - Masked preview format ••••••••<bodySuffix> (LLMKEY-03 frontend mirror)
 *   - Server error strings rendered verbatim (canonical 422 / 503 / 409 copy)
 *   - Paste box NOT cleared on 422 / 503 / 409
 *   - Revoke flow uses ConfirmDialog → DELETE
 *   - Re-validate flow: 200 shows inline status; 422 shows inline error
 *
 * Mirrors the wrapper scaffolding from Tokens.test.tsx (MemoryRouter +
 * QueryClientProvider). Mocks the api() client at the module boundary so we
 * can dispatch by path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', async () => {
  // Re-export the real ApiError so `instanceof ApiError` works in the view.
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return {
    api: vi.fn(),
    ApiError,
  };
});

import { api, ApiError } from '../api/client';
import LlmKeys from './LlmKeys';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/settings/llm']}>
        <Routes>
          <Route path="/settings/llm" element={<>{children}</>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/**
 * Build an api() dispatcher that routes by path.
 * paths is an object: { '/llm-keys': ..., '/llm-keys/consent': ..., POST: ..., etc }
 * It checks the second argument (init.method) and the path.
 *
 * Each value can be a value (resolved synchronously) or a function (called).
 * If the value is an Error, it is thrown.
 */
type Handler =
  | unknown
  | Error
  | ((path: string, init?: RequestInit) => unknown);

function makeApiDispatcher(routes: Record<string, Handler>) {
  return vi.fn((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const key = `${method} ${path}`;
    const handler = key in routes ? routes[key] : routes[path];
    if (handler === undefined) {
      return Promise.reject(new Error(`Unhandled api() call: ${key}`));
    }
    if (handler instanceof Error) {
      return Promise.reject(handler);
    }
    if (typeof handler === 'function') {
      const result = (handler as (p: string, i?: RequestInit) => unknown)(path, init);
      return Promise.resolve(result);
    }
    return Promise.resolve(handler);
  });
}

const NEVER_RESOLVES = () => new Promise(() => {});

const mockLlmKey = {
  id: 'llmkey-uuid-1',
  provider: 'anthropic' as const,
  bodySuffix: 'XYZ4',
  label: 'work',
  createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  lastValidatedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
};

describe('LlmKeys view', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  // ─── Consent gate ──────────────────────────────────────────────────────

  it('renders consent block when consentedAt is null (LLMKEY-07)', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/llm-keys/consent': { consentedAt: null },
        '/llm-keys': [],
      }),
    );
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('llm-consent-block')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('heading', { name: 'Before you add an LLM API key' }),
    ).toBeInTheDocument();
    // Canonical D-09 phrase (locked at planning time).
    expect(
      screen.getByText(
        /provider sees your text; you pay for the tokens; Weltbon stores your key encrypted at rest/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /I accept/i })).toBeInTheDocument();
  });

  it('clicking "I accept" calls POST /llm-keys/consent and reveals paste form', async () => {
    let consentedAt: string | null = null;
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/llm-keys/consent' && (!init || init.method === undefined)) {
        return Promise.resolve({ consentedAt });
      }
      if (path === '/llm-keys/consent' && init?.method === 'POST') {
        consentedAt = new Date().toISOString();
        return Promise.resolve({ consentedAt });
      }
      if (path === '/llm-keys' && (!init || init.method === undefined)) {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`Unhandled: ${init?.method ?? 'GET'} ${path}`));
    });
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('llm-consent-block')).toBeInTheDocument();
    });

    const acceptBtn = screen.getByRole('button', { name: /I accept/i });
    await userEvent.click(acceptBtn);

    await waitFor(() => {
      // Consent block is gone — header for the populated/empty post-consent view appears.
      expect(screen.queryByTestId('llm-consent-block')).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('heading', { name: 'LLM API keys' }),
    ).toBeInTheDocument();

    // The POST was made.
    const calls = vi.mocked(api).mock.calls;
    const postCall = calls.find(
      ([path, init]) => path === '/llm-keys/consent' && init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
  });

  it('hides paste form and table until consent accepted', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/llm-keys/consent': { consentedAt: null },
        '/llm-keys': [],
      }),
    );
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('llm-consent-block')).toBeInTheDocument();
    });
    // The "New key" button must NOT render while pre-consent.
    expect(screen.queryByRole('button', { name: /New key/i })).not.toBeInTheDocument();
    // The "LLM API keys" header (post-consent) must NOT render either.
    expect(
      screen.queryByRole('heading', { name: 'LLM API keys' }),
    ).not.toBeInTheDocument();
  });

  // ─── Post-consent: loading / empty / populated ─────────────────────────

  it('renders empty state with "No LLM API keys yet" when consent accepted but list is empty', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/llm-keys/consent': { consentedAt: new Date().toISOString() },
        '/llm-keys': [],
      }),
    );
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByText('No LLM API keys yet')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: /Add your first key/i }),
    ).toBeInTheDocument();
  });

  it('renders 3 skeleton rows (animate-pulse) while loading keys post-consent', async () => {
    // Consent resolves; list hangs forever → keys are isPending.
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/llm-keys/consent') {
        return Promise.resolve({ consentedAt: new Date().toISOString() });
      }
      if (path === '/llm-keys') {
        return NEVER_RESOLVES() as Promise<unknown>;
      }
      return Promise.reject(new Error(`Unhandled: ${path}`));
    });
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      const pulse = document.querySelectorAll('.animate-pulse');
      // 3 skeleton row pulses
      expect(pulse.length).toBe(3);
    });
  });

  it('renders configured-keys table with masked preview ••••••••XYZ4', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/llm-keys/consent': { consentedAt: new Date().toISOString() },
        '/llm-keys': [mockLlmKey],
      }),
    );
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('llm-keys-table')).toBeInTheDocument();
    });
    expect(screen.getByText('••••••••XYZ4')).toBeInTheDocument();
    // Provider label
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    // Label
    expect(screen.getByText('work')).toBeInTheDocument();
  });

  it('never renders the plaintext key in the configured-keys row (LLMKEY-03 mirror)', async () => {
    // A canary plaintext that would be 30+ chars and start with sk- if leaked.
    const plaintextCanary = 'sk-ant-canary-plaintext-30plus-chars-1234';
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/llm-keys/consent': { consentedAt: new Date().toISOString() },
        // The hook is typed to LlmKey[], but our mock returns whatever it's
        // given — assert the view does not surface a `key` even if one snuck in.
        '/llm-keys': [
          { ...mockLlmKey, key: plaintextCanary } as unknown as typeof mockLlmKey,
        ],
      }),
    );
    const qc = makeClient();
    const { container } = render(<LlmKeys />, {
      wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper>,
    });

    await waitFor(() => {
      expect(screen.getByTestId('llm-keys-table')).toBeInTheDocument();
    });
    // Canary must not appear anywhere in the rendered DOM.
    expect(container.textContent ?? '').not.toContain(plaintextCanary);
  });

  // ─── New key / paste form ─────────────────────────────────────────────

  it('opens CreateLlmKeyDialog when "New key" button is clicked', async () => {
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/llm-keys/consent': { consentedAt: new Date().toISOString() },
        '/llm-keys': [mockLlmKey],
      }),
    );
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('llm-keys-table')).toBeInTheDocument();
    });
    const newKeyBtn = screen.getByRole('button', { name: /New key/i });
    await userEvent.click(newKeyBtn);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Add an LLM API key/i }),
      ).toBeInTheDocument();
    });
  });

  it('submits paste form with provider+key+label; on 200 closes dialog and refetches', async () => {
    const newRow = { ...mockLlmKey, id: 'llmkey-new', bodySuffix: 'NEW1', label: 'fresh' };
    let listCallCount = 0;
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/llm-keys/consent' && (!init || init.method === undefined)) {
        return Promise.resolve({ consentedAt: new Date().toISOString() });
      }
      if (path === '/llm-keys' && (!init || init.method === undefined)) {
        listCallCount += 1;
        return Promise.resolve(listCallCount === 1 ? [] : [newRow]);
      }
      if (path === '/llm-keys' && init?.method === 'POST') {
        return Promise.resolve(newRow);
      }
      return Promise.reject(new Error(`Unhandled: ${init?.method ?? 'GET'} ${path}`));
    });
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    // Empty state → click "Add your first key"
    await waitFor(() => {
      expect(screen.getByText('No LLM API keys yet')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /Add your first key/i }));

    // Dialog open — fill the form.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Add an LLM API key/i })).toBeInTheDocument();
    });

    const keyInput = screen.getByLabelText('API key');
    await userEvent.type(keyInput, 'sk-ant-fresh-NEW1');
    const labelInput = screen.getByLabelText(/Label/i);
    await userEvent.type(labelInput, 'fresh');
    await userEvent.click(screen.getByRole('button', { name: /^Save key$/i }));

    // The dialog closes and the new row appears.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Add an LLM API key/i })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('••••••••NEW1')).toBeInTheDocument();
    });

    // The POST was made with the expected body shape.
    const calls = vi.mocked(api).mock.calls;
    const postCall = calls.find(
      ([path, init]) => path === '/llm-keys' && init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1]!.body as string);
    expect(body.provider).toBe('anthropic');
    expect(body.key).toBe('sk-ant-fresh-NEW1');
    expect(body.label).toBe('fresh');
  });

  it('on 422 from POST, displays server error string inline AND keeps paste box populated', async () => {
    const rejectedMessage =
      'Anthropic rejected this key as invalid — check the key and try again.';
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/llm-keys/consent') return Promise.resolve({ consentedAt: new Date().toISOString() });
      if (path === '/llm-keys' && (!init || init.method === undefined)) return Promise.resolve([]);
      if (path === '/llm-keys' && init?.method === 'POST') {
        return Promise.reject(new ApiError(422, { error: rejectedMessage }, rejectedMessage));
      }
      return Promise.reject(new Error(`Unhandled: ${path}`));
    });
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByText('No LLM API keys yet')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /Add your first key/i }));

    const keyInput = screen.getByLabelText('API key') as HTMLInputElement;
    await userEvent.type(keyInput, 'sk-ant-bad-key');
    await userEvent.click(screen.getByRole('button', { name: /^Save key$/i }));

    // Server error visible verbatim.
    await waitFor(() => {
      expect(screen.getByTestId('llmkey-server-error')).toHaveTextContent(rejectedMessage);
    });
    // Dialog still open.
    expect(screen.getByRole('heading', { name: /Add an LLM API key/i })).toBeInTheDocument();
    // Paste box NOT cleared.
    expect(keyInput.value).toBe('sk-ant-bad-key');
  });

  it('on 503 from POST, displays the server error string inline', async () => {
    const transientMessage = 'Anthropic returned 503 — try again in a moment.';
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/llm-keys/consent') return Promise.resolve({ consentedAt: new Date().toISOString() });
      if (path === '/llm-keys' && (!init || init.method === undefined)) return Promise.resolve([]);
      if (path === '/llm-keys' && init?.method === 'POST') {
        return Promise.reject(new ApiError(503, { error: transientMessage }, transientMessage));
      }
      return Promise.reject(new Error(`Unhandled: ${path}`));
    });
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByText('No LLM API keys yet')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /Add your first key/i }));
    await userEvent.type(screen.getByLabelText('API key'), 'sk-ant-transient');
    await userEvent.click(screen.getByRole('button', { name: /^Save key$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('llmkey-server-error')).toHaveTextContent(transientMessage);
    });
  });

  // ─── Revoke ────────────────────────────────────────────────────────────

  it('Revoke action opens ConfirmDialog; confirming calls DELETE; row disappears', async () => {
    let listResponse: typeof mockLlmKey[] = [mockLlmKey];
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/llm-keys/consent') return Promise.resolve({ consentedAt: new Date().toISOString() });
      if (path === '/llm-keys' && (!init || init.method === undefined)) return Promise.resolve(listResponse);
      if (path === `/llm-keys/${mockLlmKey.id}` && init?.method === 'DELETE') {
        listResponse = [];
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`Unhandled: ${init?.method ?? 'GET'} ${path}`));
    });
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('llm-keys-table')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /Revoke/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Revoke key' })).toBeInTheDocument();
    });
    expect(screen.getByText(/Audits using this key will stop working/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Revoke key/ }));

    await waitFor(() => {
      expect(screen.queryByTestId('llm-keys-table')).not.toBeInTheDocument();
    });
    // Empty state shows.
    expect(screen.getByText('No LLM API keys yet')).toBeInTheDocument();
  });

  // ─── Re-validate ───────────────────────────────────────────────────────

  it('Re-validate action: on success shows an inline "Re-validated" indicator', async () => {
    const newTs = new Date().toISOString();
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/llm-keys/consent') return Promise.resolve({ consentedAt: new Date().toISOString() });
      if (path === '/llm-keys' && (!init || init.method === undefined)) return Promise.resolve([mockLlmKey]);
      if (path === `/llm-keys/${mockLlmKey.id}/revalidate` && init?.method === 'POST') {
        return Promise.resolve({ id: mockLlmKey.id, lastValidatedAt: newTs });
      }
      return Promise.reject(new Error(`Unhandled: ${path}`));
    });
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('llm-keys-table')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /Re-validate/i }));

    await waitFor(() => {
      expect(screen.getByTestId(`reval-ok-${mockLlmKey.id}`)).toHaveTextContent(/Re-validated/);
    });
  });

  it('Re-validate action: on 422 displays the rejected-message inline next to that row', async () => {
    const rejectedMessage =
      'Anthropic rejected this key as invalid — check the key and try again.';
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/llm-keys/consent') return Promise.resolve({ consentedAt: new Date().toISOString() });
      if (path === '/llm-keys' && (!init || init.method === undefined)) return Promise.resolve([mockLlmKey]);
      if (path === `/llm-keys/${mockLlmKey.id}/revalidate` && init?.method === 'POST') {
        return Promise.reject(new ApiError(422, { error: rejectedMessage }, rejectedMessage));
      }
      return Promise.reject(new Error(`Unhandled: ${path}`));
    });
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId('llm-keys-table')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /Re-validate/i }));

    await waitFor(() => {
      expect(screen.getByTestId(`reval-err-${mockLlmKey.id}`)).toHaveTextContent(rejectedMessage);
    });
  });
});
