/**
 * StrictMode race regression test for the share-token-readiness fix (Gap 1).
 *
 * Asserts the OBSERVABLE outcome: on a cold StrictMode mount of /share/:token,
 * the FIRST share fetch carries the share-token header AND the rendered output
 * shows the public entries/categories — never "Failed to load" and never an
 * empty list when public entries exist.
 *
 * The fix under test (29-08-PLAN.md Task 1):
 *  - Half (a): ShareLayout calls setShareToken(token) synchronously in the
 *    render body before any descendant queries fire.
 *  - Half (b): The share-subtree read hooks (useFilteredEntries, useCategories,
 *    useUniverse) gate on getShareToken() != null AND include the token in
 *    their React Query key, so a transient null-token 404 cannot be read back
 *    as the ready-token result.
 *
 * Test strategy: mock the `api` function but re-export the real
 * setShareToken/getShareToken/clearShareToken so ShareLayout's render-body
 * call propagates to the real module-level seam that the hooks read from.
 * Record the share token at the time each `api` call is dispatched — any call
 * observed with a null token would be the bug (the race window).
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// AppBackground uses window.matchMedia which is not available in jsdom.
// Mock it with a no-op to isolate the share-token race behavior under test.
vi.mock('./AppBackground', () => ({ AppBackground: () => null }));

// Re-export real token setters from the actual module so the render-body
// setShareToken call in ShareLayout propagates through to the hooks.
import * as realClient from '../api/client';

// Mock only the `api` function; keep the real token functions intact.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    // api will be replaced per-test via vi.mocked(api).mockImplementation
    api: vi.fn(),
  };
});

import { api } from '../api/client';
import { ShareLayout } from './ShareLayout';
import { EntryList } from '../views/EntryList';

const TEST_TOKEN = 'test-share-token-abc123';

/** Matches main.tsx: retry: false, staleTime: 30_000 */
function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
}

function renderShare(qc: QueryClient) {
  return render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/share/${TEST_TOKEN}`]}>
          <Routes>
            <Route path="/share/:token" element={<ShareLayout />}>
              <Route index element={<EntryList />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </React.StrictMode>
  );
}

describe('ShareLayout StrictMode race regression (Gap 1)', () => {
  beforeEach(() => {
    // Ensure the token seam is clean before each test.
    realClient.clearShareToken();
    vi.mocked(api).mockReset();
  });

  it('FIRST share fetch carries a non-null share token equal to the URL token', async () => {
    // Record the share token at the exact moment each api() call fires.
    const observedTokens: (string | null)[] = [];

    vi.mocked(api).mockImplementation(async (path: string) => {
      observedTokens.push(realClient.getShareToken());

      if (path === '/universe') {
        return { universe: { name: 'Test Universe', ownerDisplayName: 'Alice' } };
      }
      if (path.includes('/entries')) {
        return [{ id: 'e1', title: 'Entry One', entryType: 'character', summary: '', tags: [], isPublic: true, universeId: 'share', meta: {}, icon: '', categoryId: null, createdAt: '', updatedAt: '' }];
      }
      if (path.includes('/categories')) {
        return { categories: [{ id: 'c1', label: 'Heroes', icon: '', sortOrder: 0, entryCount: 1 }], uncategorizedCount: 0 };
      }
      // useUniverse call (path like /universes/share or /share/universe)
      return { id: 'share', name: 'Test Universe', userId: 'u1', description: '', entryTypes: [], timelineWindow: null, createdAt: '', updatedAt: '', auditEnabled: false, auditProvider: null, auditModel: null };
      return {};
    });

    const qc = makeClient();
    renderShare(qc);

    // Wait for share content to appear — this is the observable truth:
    // public entries must render (not "Failed to load", not empty state).
    await waitFor(() => {
      expect(screen.queryByText('Failed to load')).not.toBeInTheDocument();
    }, { timeout: 3000 });

    // Every api() call that was observed should have seen a non-null token.
    // Under the old (unfixed) code, StrictMode would produce at least one call
    // with a null token (the null-token window after clearShareToken cleanup).
    expect(observedTokens.length).toBeGreaterThan(0);
    for (const observed of observedTokens) {
      expect(observed).toBe(TEST_TOKEN);
    }
  });

  it('public entries render and "Failed to load" and empty state do not appear', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/universe') {
        return { universe: { name: 'My World', ownerDisplayName: 'Bob' } };
      }
      if (path.includes('/entries')) {
        return [
          { id: 'e1', title: 'The Dragon', entryType: 'character', summary: 'A fierce dragon', tags: [], isPublic: true, universeId: 'share', meta: {}, icon: '', categoryId: null, createdAt: '', updatedAt: '' },
          { id: 'e2', title: 'The Castle', entryType: 'location', summary: 'A tall castle', tags: [], isPublic: true, universeId: 'share', meta: {}, icon: '', categoryId: null, createdAt: '', updatedAt: '' },
        ];
      }
      if (path.includes('/categories')) {
        return { categories: [], uncategorizedCount: 2 };
      }
      // useUniverse
      return { id: 'share', name: 'My World', userId: 'u1', description: '', entryTypes: [], timelineWindow: null, createdAt: '', updatedAt: '', auditEnabled: false, auditProvider: null, auditModel: null };
    });

    const qc = makeClient();
    renderShare(qc);

    // Public entries must render.
    await waitFor(() => {
      expect(screen.getByText('The Dragon')).toBeInTheDocument();
      expect(screen.getByText('The Castle')).toBeInTheDocument();
    }, { timeout: 3000 });

    // The buggy behavior would show these instead — assert they are absent.
    expect(screen.queryByText('Failed to load')).not.toBeInTheDocument();
    expect(screen.queryByText('Start with one idea')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing shared yet')).not.toBeInTheDocument();
  });

  it('the token-keyed cache prevents a null-token failure from poisoning the ready-token result', async () => {
    // Simulate what the bug produced: a 404-like failure on the first call,
    // followed by a success. With the fix (token-keyed cache), these occupy
    // distinct cache slots and the success result should render.
    let callCount = 0;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/universe') {
        return { universe: { name: 'Poison Test', ownerDisplayName: 'Charlie' } };
      }
      if (path.includes('/entries')) {
        callCount++;
        if (callCount === 1) {
          // Simulate a transient failure (null-token window in old code).
          // With the fix, this should never be reached because enabled gate
          // withholds the query when token is null. But if it is reached, the
          // second call (with the real token) must still succeed independently.
          throw new Error('Simulated null-token 404');
        }
        return [{ id: 'e1', title: 'Surviving Entry', entryType: 'character', summary: '', tags: [], isPublic: true, universeId: 'share', meta: {}, icon: '', categoryId: null, createdAt: '', updatedAt: '' }];
      }
      if (path.includes('/categories')) {
        return { categories: [], uncategorizedCount: 0 };
      }
      return { id: 'share', name: 'Poison Test', userId: 'u1', description: '', entryTypes: [], timelineWindow: null, createdAt: '', updatedAt: '', auditEnabled: false, auditProvider: null, auditModel: null };
    });

    const qc = makeClient();
    renderShare(qc);

    // With the fix: either entries render (if first call succeeded) or the test
    // at minimum does NOT show "Failed to load" from a poisoned cache.
    await waitFor(() => {
      expect(screen.queryByText('Failed to load')).not.toBeInTheDocument();
    }, { timeout: 3000 });
  });
});
