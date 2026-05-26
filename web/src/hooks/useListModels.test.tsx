/**
 * Phase 27 Plan 04 Task 1 — useListModels hook tests.
 *
 * Pins:
 *   - The hook issues a fetch to `/llm/models?provider=<p>` when a provider is supplied.
 *   - The hook is disabled (no fetch issued) when provider is undefined.
 *   - The query's staleTime is 1_800_000ms (30 min) — aligned to Phase 27 D-01
 *     backend cache TTL so the frontend does not re-trigger the cache miss.
 *   - The wire-shape types `ListingsResult` and `ModelListingWithCoverage`
 *     are exported from `web/src/types/audit.ts` with the correct shape.
 *   - `AuditRun.costUnknown: boolean` and `LlmKey.costUnknownCount: number`
 *     are present in the wire-shape type definitions (Phase 27 D-06).
 *   - `web/src/data/pricing.ts PRICING_AS_OF` matches the API-side value
 *     in `api/src/providers/llm/pricing.ts` exactly (string equality).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));

import { api } from '../api/client';
import { useListModels, type AuditRun } from './useAudits';
import type { ListingsResult, ModelListingWithCoverage, AuditHistoryRow } from '../types/audit';
import type { LlmKey } from './useLlmKeys';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const SAMPLE_LISTING: ListingsResult = {
  models: [
    { id: 'claude-haiku-4-5-20251001', hasPricing: true, pricing: { id: 'claude-haiku-4-5-20251001', inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 } },
    { id: 'claude-future-snapshot-9', hasPricing: false },
  ],
  source: 'live',
  fetchedAt: '2026-05-26T20:00:00.000Z',
};

describe('useListModels — Phase 27 D-01 (live model catalog hook)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('Test 1 — fetches when provider is defined', async () => {
    vi.mocked(api).mockResolvedValue(SAMPLE_LISTING as never);
    const qc = makeClient();
    const wrapper = makeWrapper(qc);

    const { result } = renderHook(() => useListModels('anthropic'), { wrapper });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    // The hook issued exactly one fetch to the correct path with the provider
    // in the query string.
    const calls = vi.mocked(api).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0][0]).toBe('/llm/models?provider=anthropic');
    expect(result.current.data).toEqual(SAMPLE_LISTING);
  });

  it('Test 2 — is disabled (issues no fetch) when provider is undefined', async () => {
    vi.mocked(api).mockResolvedValue(SAMPLE_LISTING as never);
    const qc = makeClient();
    const wrapper = makeWrapper(qc);

    const { result } = renderHook(() => useListModels(undefined), { wrapper });

    // Give the hook a tick — there should be no fetch.
    await new Promise((r) => setTimeout(r, 30));

    expect(vi.mocked(api)).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('Test 3 — staleTime is 1_800_000ms (30 min) per Phase 27 D-01', async () => {
    vi.mocked(api).mockResolvedValue(SAMPLE_LISTING as never);
    const qc = makeClient();
    const wrapper = makeWrapper(qc);

    renderHook(() => useListModels('anthropic'), { wrapper });

    await waitFor(() => {
      const state = qc.getQueryState(['llm-models', 'anthropic']);
      expect(state).toBeDefined();
      expect(state?.data).toBeDefined();
    });

    // Pull the cached query and inspect its options.
    const cache = qc.getQueryCache();
    const entry = cache.find({ queryKey: ['llm-models', 'anthropic'] });
    expect(entry).toBeDefined();
    // staleTime is typed as `unknown` on QueryOptions because TanStack Query
    // generics widen it for the union of value/function — narrow at the
    // assertion site.
    const options = entry?.options as { staleTime?: number } | undefined;
    expect(options?.staleTime).toBe(1_800_000);
  });
});

describe('Phase 27 Plan 04 Task 1 — wire-shape type mirrors', () => {
  it('Test 4a — ListingsResult and ModelListingWithCoverage are structurally usable', () => {
    // Compile-time check: assignment must succeed for the right shape, fail
    // for the wrong shape. Vitest runs against tsc-compiled JS so a structural
    // mismatch here would be caught by tsc --noEmit upstream — this assertion
    // documents the intent for human readers.
    const m: ModelListingWithCoverage = {
      id: 'x',
      hasPricing: false,
    };
    const r: ListingsResult = {
      models: [m],
      source: 'pricing_fallback',
      fetchedAt: '2026-05-26T00:00:00.000Z',
    };
    expect(r.models[0].id).toBe('x');
    expect(r.source).toBe('pricing_fallback');
  });

  it('Test 4b — AuditRun + AuditHistoryRow include costUnknown: boolean', () => {
    // Structural test: build a value that includes costUnknown; if the type
    // lacks the field, tsc errors out at compile time.
    const row: AuditHistoryRow = {
      id: '00000000-0000-0000-0000-000000000000',
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
    };
    expect(row.costUnknown).toBe(false);

    const partialRun: Partial<AuditRun> & { costUnknown: boolean } = {
      costUnknown: true,
    };
    expect(partialRun.costUnknown).toBe(true);
  });

  it('Test 4c — LlmKey includes costUnknownCount: number', () => {
    const key: LlmKey = {
      id: '00000000-0000-0000-0000-000000000001',
      provider: 'anthropic',
      bodySuffix: 'XYZ4',
      label: 'work',
      createdAt: '2026-05-26T00:00:00.000Z',
      lastValidatedAt: '2026-05-26T00:00:00.000Z',
      totalSpentUsd: '0.0042',
      costUnknownCount: 2,
    };
    expect(key.costUnknownCount).toBe(2);
  });
});

describe('Phase 27 Plan 04 Task 1 — PRICING_AS_OF sync', () => {
  it('Test 5 — web/src/data/pricing.ts PRICING_AS_OF matches api/src/providers/llm/pricing.ts exactly', () => {
    // Read both files at test time so the assertion catches drift even if
    // someone bumps one side without the other.
    const here = dirname(fileURLToPath(import.meta.url));
    const apiPath = resolve(here, '../../../api/src/providers/llm/pricing.ts');
    const webPath = resolve(here, '../data/pricing.ts');
    const apiText = readFileSync(apiPath, 'utf8');
    const webText = readFileSync(webPath, 'utf8');

    const apiMatch = apiText.match(/PRICING_AS_OF\s*=\s*['"]([^'"]+)['"]/);
    const webMatch = webText.match(/PRICING_AS_OF\s*=\s*['"]([^'"]+)['"]/);
    expect(apiMatch).not.toBeNull();
    expect(webMatch).not.toBeNull();
    expect(webMatch![1]).toBe(apiMatch![1]);
  });
});
