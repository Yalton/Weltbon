/**
 * Phase 27 follow-up — automated tests for LlmKeys view
 * "(plus N runs with unknown pricing)" footnote (D-06).
 *
 * Mocks useLlmKeys, useLlmConsent, and useListModels (used by PricingTable
 * which LlmKeys mounts) so no real API key or network is required.
 *
 * Coverage:
 *   5. When a key's unknownCount > 0 the "(plus N runs with unknown pricing)"
 *      footnote renders with the correct N.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../hooks/useLlmKeys', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useLlmKeys')>('../hooks/useLlmKeys');
  return {
    ...actual,
    useLlmKeys: vi.fn(),
    useLlmConsent: vi.fn(),
    useGrantLlmConsent: vi.fn(),
    useRevokeLlmKey: vi.fn(),
    useRevalidateLlmKey: vi.fn(),
  };
});

// PricingTable (mounted inside LlmKeys) calls useListModels — stub it to avoid
// network calls.
vi.mock('../hooks/useAudits', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useAudits')>('../hooks/useAudits');
  return { ...actual, useListModels: vi.fn() };
});

import {
  useLlmKeys,
  useLlmConsent,
  useGrantLlmConsent,
  useRevokeLlmKey,
  useRevalidateLlmKey,
} from '../hooks/useLlmKeys';
import { useListModels } from '../hooks/useAudits';
import type { LlmKey } from '../hooks/useLlmKeys';
import LlmKeys from './LlmKeys';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeLlmKey(overrides: Partial<LlmKey> = {}): LlmKey {
  return {
    id: 'key-1',
    provider: 'anthropic',
    bodySuffix: 'XXXX',
    label: 'My Anthropic key',
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    lastValidatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    totalSpentUsd: '1.2345',
    unknownCount: 0,
    ...overrides,
  };
}

/** Stub mutation hooks with minimal shape. */
function stubMutations() {
  vi.mocked(useGrantLlmConsent).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    context: undefined,
    failureCount: 0,
    failureReason: null,
    isIdle: true,
    isSuccess: false,
    isPaused: false,
    status: 'idle',
    submittedAt: 0,
    variables: undefined,
  } as unknown as ReturnType<typeof useGrantLlmConsent>);

  vi.mocked(useRevokeLlmKey).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    context: undefined,
    failureCount: 0,
    failureReason: null,
    isIdle: true,
    isSuccess: false,
    isPaused: false,
    status: 'idle',
    submittedAt: 0,
    variables: undefined,
  } as unknown as ReturnType<typeof useRevokeLlmKey>);

  vi.mocked(useRevalidateLlmKey).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    data: undefined,
    reset: vi.fn(),
    context: undefined,
    failureCount: 0,
    failureReason: null,
    isIdle: true,
    isSuccess: false,
    isPaused: false,
    status: 'idle',
    submittedAt: 0,
    variables: undefined,
  } as unknown as ReturnType<typeof useRevalidateLlmKey>);
}

function renderLlmKeys() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LlmKeys />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LlmKeys — unknown pricing footnote (Phase 27 D-06)', () => {
  beforeEach(() => {
    // Consent already granted — skip the consent gate so the keys table renders.
    vi.mocked(useLlmConsent).mockReturnValue({
      data: { consentedAt: '2026-01-01T00:00:00Z' },
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmConsent>);

    // useListModels: return empty / undefined so PricingTable doesn't affect assertions.
    vi.mocked(useListModels).mockReturnValue({
      data: undefined,
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: false,
      isError: false,
      error: null,
    } as ReturnType<typeof useListModels>);

    stubMutations();
  });

  it('5a: renders "(plus N runs with unknown pricing)" when unknownCount > 0', () => {
    vi.mocked(useLlmKeys).mockReturnValue({
      data: [makeLlmKey({ unknownCount: 3 })],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmKeys>);

    renderLlmKeys();

    // The footnote substring as it appears in the component.
    expect(screen.getByText(/plus 3 runs with unknown pricing/i)).toBeInTheDocument();
  });

  it('5a: N in the footnote matches unknownCount exactly', () => {
    vi.mocked(useLlmKeys).mockReturnValue({
      data: [makeLlmKey({ unknownCount: 7 })],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmKeys>);

    renderLlmKeys();

    expect(screen.getByText(/plus 7 runs with unknown pricing/i)).toBeInTheDocument();
  });

  it('5b: footnote is absent when unknownCount is 0', () => {
    vi.mocked(useLlmKeys).mockReturnValue({
      data: [makeLlmKey({ unknownCount: 0 })],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmKeys>);

    renderLlmKeys();

    expect(screen.queryByText(/with unknown pricing/i)).toBeNull();
  });

  it('5b: footnote is absent when unknownCount is undefined (pre-Phase-27 row)', () => {
    const keyWithoutUnknownCount = {
      ...makeLlmKey(),
      unknownCount: undefined as unknown as number,
    };
    vi.mocked(useLlmKeys).mockReturnValue({
      data: [keyWithoutUnknownCount],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmKeys>);

    renderLlmKeys();

    expect(screen.queryByText(/with unknown pricing/i)).toBeNull();
  });

  it('5c: singular "run" vs plural "runs" in the footnote', () => {
    vi.mocked(useLlmKeys).mockReturnValue({
      data: [makeLlmKey({ unknownCount: 1 })],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmKeys>);

    renderLlmKeys();

    // When N=1 the component renders "run" (singular) not "runs".
    expect(screen.getByText(/plus 1 run with unknown pricing/i)).toBeInTheDocument();
  });

  it('5d: each key row independently shows its own footnote when unknownCount > 0', () => {
    vi.mocked(useLlmKeys).mockReturnValue({
      data: [
        makeLlmKey({ id: 'key-1', provider: 'anthropic', unknownCount: 4 }),
        makeLlmKey({ id: 'key-2', provider: 'openai', unknownCount: 2 }),
      ],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmKeys>);

    renderLlmKeys();

    expect(screen.getByText(/plus 4 runs with unknown pricing/i)).toBeInTheDocument();
    expect(screen.getByText(/plus 2 runs with unknown pricing/i)).toBeInTheDocument();
  });

  it('5d: only the row with unknownCount > 0 shows the footnote', () => {
    vi.mocked(useLlmKeys).mockReturnValue({
      data: [
        makeLlmKey({ id: 'key-1', provider: 'anthropic', unknownCount: 5 }),
        makeLlmKey({ id: 'key-2', provider: 'openai', unknownCount: 0 }),
      ],
      isPending: false,
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
    } as ReturnType<typeof useLlmKeys>);

    renderLlmKeys();

    // Only one footnote should appear.
    expect(screen.getAllByText(/with unknown pricing/i)).toHaveLength(1);
    expect(screen.getByText(/plus 5 runs with unknown pricing/i)).toBeInTheDocument();
  });
});
