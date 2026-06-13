/**
 * Phase 27 follow-up — automated tests for PricingTable
 * "additional models available without published rates" caption (D-07).
 *
 * Mocks useListModels so no real API key or network is required.
 *
 * Coverage:
 *   4. When the live-model count exceeds the PRICING entry count the caption
 *      "…additional models available without published rates…" renders.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ─── Module mock ──────────────────────────────────────────────────────────────

vi.mock('../hooks/useAudits', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useAudits')>('../hooks/useAudits');
  return { ...actual, useListModels: vi.fn() };
});

import { useListModels } from '../hooks/useAudits';
import type { ModelsResponse } from '../hooks/useAudits';
import { PRICING } from '../data/pricing';
import { PricingTable } from './PricingTable';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderTable() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PricingTable />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Build a ModelsResponse with the given IDs for anthropic. */
function anthropicResponse(ids: string[]): ModelsResponse {
  return {
    models: ids.map((id) => ({
      id,
      hasPricing: id in PRICING.anthropic,
    })),
    source: 'live',
    fetchedAt: '2026-06-06T00:00:00Z',
  };
}

/** Build a ModelsResponse with the given IDs for openai. */
function openaiResponse(ids: string[]): ModelsResponse {
  return {
    models: ids.map((id) => ({
      id,
      hasPricing: id in PRICING.openai,
    })),
    source: 'live',
    fetchedAt: '2026-06-06T00:00:00Z',
  };
}

const pricedAnthropicIds = Object.keys(PRICING.anthropic);
const pricedOpenAIIds = Object.keys(PRICING.openai);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PricingTable — overflow caption (Phase 27 D-07)', () => {
  beforeEach(() => {
    vi.mocked(useListModels).mockReset();
  });

  it('4a: caption renders when live model count exceeds PRICING entry count', async () => {
    const user = userEvent.setup();

    // Give anthropic 2 extra live models beyond the PRICING set.
    vi.mocked(useListModels).mockImplementation((provider) => {
      const response =
        provider === 'anthropic'
          ? anthropicResponse([
              ...pricedAnthropicIds,
              'claude-new-a-20260101',
              'claude-new-b-20260101',
            ])
          : openaiResponse(pricedOpenAIIds);
      return {
        data: response,
        isPending: false,
        isLoading: false,
        isFetching: false,
        isSuccess: true,
        isError: false,
        error: null,
      } as ReturnType<typeof useListModels>;
    });

    renderTable();

    // The <details> element starts collapsed — open it so the caption renders.
    await user.click(screen.getByText(/Models & pricing/i));

    // The caption substring as it appears in the component.
    expect(
      await screen.findByText(/additional models? available without published rates/i),
    ).toBeInTheDocument();
  });

  it('4a: caption includes the correct N count (2 extra anthropic models)', async () => {
    const user = userEvent.setup();

    vi.mocked(useListModels).mockImplementation((provider) => {
      const response =
        provider === 'anthropic'
          ? anthropicResponse([
              ...pricedAnthropicIds,
              'claude-new-a-20260101',
              'claude-new-b-20260101',
            ])
          : openaiResponse(pricedOpenAIIds);
      return {
        data: response,
        isPending: false,
        isLoading: false,
        isFetching: false,
        isSuccess: true,
        isError: false,
        error: null,
      } as ReturnType<typeof useListModels>;
    });

    renderTable();

    await user.click(screen.getByText(/Models & pricing/i));

    // unpricedCount = (priced+2 anthropic + priced openai) - (priced anthropic + priced openai) = 2
    expect(
      await screen.findByText(/2 additional models? available without published rates/i),
    ).toBeInTheDocument();
  });

  it('4b: caption includes "see model picker in universe settings"', async () => {
    const user = userEvent.setup();

    vi.mocked(useListModels).mockImplementation((provider) => {
      const response =
        provider === 'anthropic'
          ? anthropicResponse([...pricedAnthropicIds, 'claude-new-20260101'])
          : openaiResponse(pricedOpenAIIds);
      return {
        data: response,
        isPending: false,
        isLoading: false,
        isFetching: false,
        isSuccess: true,
        isError: false,
        error: null,
      } as ReturnType<typeof useListModels>;
    });

    renderTable();

    await user.click(screen.getByText(/Models & pricing/i));

    expect(
      await screen.findByText(/see model picker in universe settings/i),
    ).toBeInTheDocument();
  });

  it('4c: caption does NOT render when live list equals the PRICING set', async () => {
    const user = userEvent.setup();

    // Exactly the priced models — no extras.
    vi.mocked(useListModels).mockImplementation((provider) => {
      const response =
        provider === 'anthropic'
          ? anthropicResponse(pricedAnthropicIds)
          : openaiResponse(pricedOpenAIIds);
      return {
        data: response,
        isPending: false,
        isLoading: false,
        isFetching: false,
        isSuccess: true,
        isError: false,
        error: null,
      } as ReturnType<typeof useListModels>;
    });

    renderTable();

    await user.click(screen.getByText(/Models & pricing/i));

    // Wait for the table to be populated (avoids false-positive on "not found before render").
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(
      screen.queryByText(/additional models? available without published rates/i),
    ).toBeNull();
  });

  it('4d: caption does NOT render when live list data is not yet loaded', async () => {
    const user = userEvent.setup();

    // Both providers return undefined (loading state).
    vi.mocked(useListModels).mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: true,
      isFetching: true,
      isSuccess: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useListModels>);

    renderTable();

    await user.click(screen.getByText(/Models & pricing/i));

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(
      screen.queryByText(/additional models? available without published rates/i),
    ).toBeNull();
  });

  it('4e: singular "model" vs plural "models" in caption', async () => {
    const user = userEvent.setup();

    // Only 1 extra model across both providers.
    vi.mocked(useListModels).mockImplementation((provider) => {
      const response =
        provider === 'anthropic'
          ? anthropicResponse([...pricedAnthropicIds, 'claude-new-20260101'])
          : openaiResponse(pricedOpenAIIds);
      return {
        data: response,
        isPending: false,
        isLoading: false,
        isFetching: false,
        isSuccess: true,
        isError: false,
        error: null,
      } as ReturnType<typeof useListModels>;
    });

    renderTable();

    await user.click(screen.getByText(/Models & pricing/i));

    // When N=1 the component renders "model" (singular) not "models".
    expect(
      await screen.findByText(/1 additional model available without published rates/i),
    ).toBeInTheDocument();
  });
});
