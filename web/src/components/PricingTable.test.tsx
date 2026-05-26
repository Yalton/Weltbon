/**
 * Phase 27 Plan 04 Task 2 — PricingTable overflow caption test (D-07).
 *
 * Pins:
 *   - When the live list (`useListModels`) contains models absent from
 *     PRICING for a provider, the table renders a caption beneath it with
 *     the exact CONTEXT copy and the correct N.
 *   - When the live list and PRICING agree (no overflow), no caption appears.
 *
 * PricingTable is mounted with no required prop in production; the live
 * count is summed across both providers (CONTEXT line 175 + PATTERNS line 447).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, api: vi.fn() };
});
import { api } from '../api/client';
import { PricingTable } from './PricingTable';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function Wrapper({ children, qc }: { children: ReactNode; qc: QueryClient }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('PricingTable — Phase 27 D-07 overflow caption', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('Test 5 — renders caption when live list has unpriced models for at least one provider', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/llm/models?provider=anthropic') {
        return {
          models: [
            { id: 'claude-haiku-4-5-20251001', hasPricing: true },
            { id: 'claude-sonnet-4-6', hasPricing: true },
            { id: 'claude-opus-4-7', hasPricing: true },
            { id: 'claude-future-snapshot-9', hasPricing: false },
            { id: 'claude-future-snapshot-10', hasPricing: false },
          ],
          source: 'live',
          fetchedAt: '2026-05-26T00:00:00.000Z',
        } as never;
      }
      if (path === '/llm/models?provider=openai') {
        return {
          models: [
            { id: 'gpt-5-mini', hasPricing: true },
            { id: 'gpt-5', hasPricing: true },
            { id: 'gpt-5-pro', hasPricing: true },
            { id: 'gpt-future', hasPricing: false },
          ],
          source: 'live',
          fetchedAt: '2026-05-26T00:00:00.000Z',
        } as never;
      }
      return null as never;
    });

    const qc = makeClient();
    render(<PricingTable />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    // 3 unpriced total across both providers (2 anthropic + 1 openai).
    await waitFor(() => {
      expect(
        screen.getByText(
          /3 additional models available without published rates — see model picker in universe settings/i,
        ),
      ).toBeInTheDocument();
    });
  });

  it('Test 6 — does NOT render caption when overflow is 0', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/llm/models?provider=anthropic') {
        return {
          models: [
            { id: 'claude-haiku-4-5-20251001', hasPricing: true },
            { id: 'claude-sonnet-4-6', hasPricing: true },
            { id: 'claude-opus-4-7', hasPricing: true },
          ],
          source: 'live',
          fetchedAt: '2026-05-26T00:00:00.000Z',
        } as never;
      }
      if (path === '/llm/models?provider=openai') {
        return {
          models: [
            { id: 'gpt-5-mini', hasPricing: true },
            { id: 'gpt-5', hasPricing: true },
            { id: 'gpt-5-pro', hasPricing: true },
          ],
          source: 'live',
          fetchedAt: '2026-05-26T00:00:00.000Z',
        } as never;
      }
      return null as never;
    });

    const qc = makeClient();
    render(<PricingTable />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    // Wait long enough for both queries to settle then assert absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(
      screen.queryByText(/additional models available without published rates/i),
    ).not.toBeInTheDocument();
  });

  it('Test 7 — caption is absent when the live calls have not yet returned', async () => {
    // Never-resolving promises — the table should still render the priced
    // rows but the caption depends on resolved data and must not show until
    // ready (no flicker of "0 additional models …").
    vi.mocked(api).mockImplementation(() => new Promise(() => {}) as never);
    const qc = makeClient();
    render(<PricingTable />, { wrapper: ({ children }) => <Wrapper qc={qc}>{children}</Wrapper> });

    // The PRICING-only base table still renders. The summary text includes
    // a leading toggle glyph (▸/▾) so match by substring.
    expect(screen.getByText(/Models & pricing/)).toBeInTheDocument();
    expect(
      screen.queryByText(/additional models available without published rates/i),
    ).not.toBeInTheDocument();
  });
});
