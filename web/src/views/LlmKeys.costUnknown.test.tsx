
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', async () => {
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
  return { api: vi.fn(), ApiError };
});

import { api } from '../api/client';
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

function makeApiMock(llmKeys: unknown[]) {
  return vi.fn(async (path: string) => {
    if (path === '/llm-keys/consent') return { consentedAt: new Date().toISOString() };
    if (path === '/llm-keys') return llmKeys;
    if (path.startsWith('/llm/models')) {
      return { models: [], source: 'pricing_fallback', fetchedAt: '2026-05-26T00:00:00.000Z' };
    }
    return null;
  });
}

const BASE_KEY = {
  id: '00000000-0000-0000-0000-000000000001',
  provider: 'anthropic' as const,
  bodySuffix: 'XYZ4',
  label: 'work',
  createdAt: '2026-05-24T00:00:00.000Z',
  lastValidatedAt: '2026-05-25T00:00:00.000Z',
  totalSpentUsd: '0.0042',
};

describe('LlmKeys — D-06 cost_unknown footnote', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('Test 6 — renders "(plus N runs with unknown pricing)" footnote when costUnknownCount > 0', async () => {
    vi.mocked(api).mockImplementation(
      makeApiMock([{ ...BASE_KEY, costUnknownCount: 2 }]),
    );
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId(`llmkey-total-spent-${BASE_KEY.id}`)).toBeInTheDocument();
    });
    const cell = screen.getByTestId(`llmkey-total-spent-${BASE_KEY.id}`);
    expect(cell.textContent).toMatch(/\$0\.0042/);
    expect(cell.textContent).toMatch(/\(plus 2 runs with unknown pricing\)/);

    // Footnote tone is NEUTRAL (NOT amber).
    const footnote = cell.querySelector('span');
    expect(footnote).not.toBeNull();
    expect(footnote!.className).toMatch(/text-neutral-500/);
    expect(footnote!.className).not.toMatch(/text-amber-700/);
  });

  it('Test 7 — does NOT render footnote when costUnknownCount === 0', async () => {
    vi.mocked(api).mockImplementation(
      makeApiMock([{ ...BASE_KEY, costUnknownCount: 0 }]),
    );
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId(`llmkey-total-spent-${BASE_KEY.id}`)).toBeInTheDocument();
    });
    const cell = screen.getByTestId(`llmkey-total-spent-${BASE_KEY.id}`);
    expect(cell.textContent).toMatch(/\$0\.0042/);
    expect(cell.textContent).not.toMatch(/runs with unknown pricing/);
  });

  it('Test 7b — undefined costUnknownCount is treated as 0 (backward compatibility)', async () => {
    vi.mocked(api).mockImplementation(
      // BASE_KEY has no costUnknownCount field at all.
      makeApiMock([BASE_KEY]),
    );
    const qc = makeClient();
    render(<LlmKeys />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    await waitFor(() => {
      expect(screen.getByTestId(`llmkey-total-spent-${BASE_KEY.id}`)).toBeInTheDocument();
    });
    const cell = screen.getByTestId(`llmkey-total-spent-${BASE_KEY.id}`);
    expect(cell.textContent).not.toMatch(/runs with unknown pricing/);
  });
});
