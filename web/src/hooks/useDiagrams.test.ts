import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';

// Per-file mock of api/client — prevents blast radius onto sibling tests
vi.mock('../api/client', () => ({ api: vi.fn() }));
import { api } from '../api/client';
import { useDiagrams, useCreateDiagram, type DiagramSummary } from './useDiagrams';

const UNIVERSE_ID = 'UNI-1';

const fixtureDiagram: DiagramSummary = {
  id: 'D1',
  universeId: UNIVERSE_ID,
  name: 'Family Tree',
  description: null,
  createdAt: '2026-05-31T00:00:00Z',
};

function wrapperFactory(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe('useDiagrams', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('fires GET against ["diagrams", universeId] key', async () => {
    vi.mocked(api).mockResolvedValue([fixtureDiagram]);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useDiagrams(UNIVERSE_ID), {
      wrapper: wrapperFactory(qc),
    });

    // Wait for the query to settle
    await vi.waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual([fixtureDiagram]);

    // Assert the api call hit the correct URL
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/diagrams`,
    );

    // Assert the active query key is the diagrams key
    const queries = qc.getQueryCache().getAll();
    const diagramsQuery = queries.find(
      (q) =>
        JSON.stringify(q.queryKey) ===
        JSON.stringify(['diagrams', UNIVERSE_ID]),
    );
    expect(diagramsQuery).toBeDefined();
  });
});

describe('useCreateDiagram — query-key isolation (T-31-07 mitigate)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('invalidates ["diagrams", universeId] but leaves a seeded ["graph-data", universeId] entry intact', async () => {
    vi.mocked(api).mockResolvedValue(fixtureDiagram);

    const qc = makeQueryClient();

    // Seed a ["graph-data", universeId] cache entry — simulates the force-graph query
    qc.setQueryData(['graph-data', UNIVERSE_ID], {
      nodes: [{ id: 'N1' }],
      edges: [],
      positions: [],
    });

    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateDiagram(UNIVERSE_ID), {
      wrapper: wrapperFactory(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ name: 'New Diagram' });
    });

    // Mutation should have invalidated ONLY the diagrams key
    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown[] }).queryKey),
    );
    expect(invalidatedKeys).toContain(
      JSON.stringify(['diagrams', UNIVERSE_ID]),
    );
    expect(invalidatedKeys).not.toContain(
      JSON.stringify(['graph-data', UNIVERSE_ID]),
    );

    // The seeded graph-data cache entry must still exist (not invalidated/removed)
    const graphDataEntry = qc.getQueryData(['graph-data', UNIVERSE_ID]);
    expect(graphDataEntry).toBeDefined();
    expect(graphDataEntry).toMatchObject({ nodes: [{ id: 'N1' }] });
  });
});
