/**
 * Phase 32 Plan 03 — useDictionary hook tests (Wave 0 target file).
 *
 * Per-file mock of api/client — prevents blast radius onto sibling tests.
 * (project memory: react-query-key-change-blast-radius)
 *
 * Asserts:
 *   (a) useFilteredDictionary builds the right URL and query key for {q},
 *       {lid}, and {q+lid}.
 *   (b) Each mutation calls the correct method + path.
 *   (c) Mutations invalidate the ['dictionary', universeId] prefix.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';

// Per-file mock — must be hoisted before the import of the hook under test.
vi.mock('../api/client', () => ({ api: vi.fn() }));
import { api } from '../api/client';
import {
  useFilteredDictionary,
  useCreateWord,
  useUpdateWord,
  useDeleteWord,
  useImportDictionaryCsv,
  type DictionaryWord,
} from './useDictionary';

const UNIVERSE_ID = 'uni-1111';
const WORD_ID = 'word-aaaa';

const fixtureWord: DictionaryWord = {
  id: WORD_ID,
  universeId: UNIVERSE_ID,
  languageEntryId: null,
  word: 'kʼeʔ',
  ipa: 'kʼeʔ',
  partOfSpeech: 'noun',
  gloss: 'stone',
  etymology: 'From Proto-X *keq',
  tags: ['nature'],
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFactory(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

// ─── (a) useFilteredDictionary query-key + URL ──────────────────────────────

describe('useFilteredDictionary', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('(a1) {q only} — uses ?q= in the URL and keyed on {q, lid:null}', async () => {
    vi.mocked(api).mockResolvedValue([fixtureWord]);

    const qc = makeQueryClient();
    const filters = { q: 'stone', lid: null };

    const { result } = renderHook(
      () => useFilteredDictionary(UNIVERSE_ID, filters),
      { wrapper: wrapperFactory(qc) },
    );

    await vi.waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const calledPath = vi.mocked(api).mock.calls[0][0] as string;
    expect(calledPath).toContain('/universes/' + UNIVERSE_ID + '/dictionary');
    expect(calledPath).toContain('q=stone');
    expect(calledPath).not.toContain('lid=');

    // Query key must include the full filter object
    const queries = qc.getQueryCache().getAll();
    const dictQuery = queries.find(
      (q) =>
        JSON.stringify(q.queryKey) ===
        JSON.stringify(['dictionary', UNIVERSE_ID, filters]),
    );
    expect(dictQuery).toBeDefined();
  });

  it('(a2) {lid only} — uses ?lid= in the URL and keyed on {q:"", lid}', async () => {
    vi.mocked(api).mockResolvedValue([fixtureWord]);

    const qc = makeQueryClient();
    const filters = { q: '', lid: 'lang-bbbb' };

    const { result } = renderHook(
      () => useFilteredDictionary(UNIVERSE_ID, filters),
      { wrapper: wrapperFactory(qc) },
    );

    await vi.waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const calledPath = vi.mocked(api).mock.calls[0][0] as string;
    expect(calledPath).toContain('lid=lang-bbbb');
    expect(calledPath).not.toContain('q=');
  });

  it('(a3) {q+lid} — uses both params; distinct key from {q-only}', async () => {
    vi.mocked(api).mockResolvedValue([fixtureWord]);

    const qc = makeQueryClient();
    const filters = { q: 'stone', lid: 'lang-bbbb' };

    const { result } = renderHook(
      () => useFilteredDictionary(UNIVERSE_ID, filters),
      { wrapper: wrapperFactory(qc) },
    );

    await vi.waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const calledPath = vi.mocked(api).mock.calls[0][0] as string;
    expect(calledPath).toContain('q=stone');
    expect(calledPath).toContain('lid=lang-bbbb');

    // The key with {q+lid} must differ from the key with {q-only}
    const filterQOnly = { q: 'stone', lid: null };
    expect(JSON.stringify(['dictionary', UNIVERSE_ID, filters])).not.toBe(
      JSON.stringify(['dictionary', UNIVERSE_ID, filterQOnly]),
    );
  });
});

// ─── (b) mutation method + path ─────────────────────────────────────────────

describe('useCreateWord', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('(b1) POSTs to /universes/:uid/dictionary', async () => {
    vi.mocked(api).mockResolvedValue(fixtureWord);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useCreateWord(UNIVERSE_ID), {
      wrapper: wrapperFactory(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({
        word: 'kʼeʔ',
        gloss: 'stone',
        languageEntryId: null,
      });
    });

    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/dictionary`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('useUpdateWord', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('(b2) PATCHes to /universes/:uid/dictionary/:wid', async () => {
    vi.mocked(api).mockResolvedValue(fixtureWord);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useUpdateWord(UNIVERSE_ID, WORD_ID), {
      wrapper: wrapperFactory(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ gloss: 'rock' });
    });

    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/dictionary/${WORD_ID}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});

describe('useDeleteWord', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('(b3) DELETEs to /universes/:uid/dictionary/:wid', async () => {
    vi.mocked(api).mockResolvedValue(undefined);

    const qc = makeQueryClient();
    const { result } = renderHook(() => useDeleteWord(UNIVERSE_ID, WORD_ID), {
      wrapper: wrapperFactory(qc),
    });

    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/dictionary/${WORD_ID}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('useImportDictionaryCsv', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('(b4) POSTs FormData to /universes/:uid/dictionary/import', async () => {
    vi.mocked(api).mockResolvedValue({ inserted: 5, updated: 1, rowErrors: [] });

    const qc = makeQueryClient();
    const { result } = renderHook(
      () => useImportDictionaryCsv(UNIVERSE_ID),
      { wrapper: wrapperFactory(qc) },
    );

    const fakeFile = new File(['word,gloss\nkʼeʔ,stone'], 'words.csv', {
      type: 'text/csv',
    });

    await act(async () => {
      await result.current.mutateAsync(fakeFile);
    });

    const [calledPath, calledInit] = vi.mocked(api).mock.calls[0];
    expect(calledPath).toBe(`/universes/${UNIVERSE_ID}/dictionary/import`);
    expect((calledInit as RequestInit).method).toBe('POST');
    expect((calledInit as RequestInit).body).toBeInstanceOf(FormData);
  });
});

// ─── (c) prefix invalidation ─────────────────────────────────────────────────

describe('mutation prefix invalidation', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('(c1) useCreateWord invalidates ["dictionary", universeId] prefix', async () => {
    vi.mocked(api).mockResolvedValue(fixtureWord);

    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useCreateWord(UNIVERSE_ID), {
      wrapper: wrapperFactory(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ word: 'foo', gloss: 'bar', languageEntryId: null });
    });

    const keys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown[] }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['dictionary', UNIVERSE_ID]));
  });

  it('(c2) useUpdateWord invalidates ["dictionary", universeId] prefix', async () => {
    vi.mocked(api).mockResolvedValue(fixtureWord);

    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(
      () => useUpdateWord(UNIVERSE_ID, WORD_ID),
      { wrapper: wrapperFactory(qc) },
    );

    await act(async () => {
      await result.current.mutateAsync({ gloss: 'rock' });
    });

    const keys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown[] }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['dictionary', UNIVERSE_ID]));
  });

  it('(c3) useDeleteWord invalidates ["dictionary", universeId] prefix', async () => {
    vi.mocked(api).mockResolvedValue(undefined);

    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(
      () => useDeleteWord(UNIVERSE_ID, WORD_ID),
      { wrapper: wrapperFactory(qc) },
    );

    await act(async () => {
      await result.current.mutateAsync();
    });

    const keys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown[] }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['dictionary', UNIVERSE_ID]));
  });

  it('(c4) useImportDictionaryCsv invalidates ["dictionary", universeId] prefix', async () => {
    vi.mocked(api).mockResolvedValue({ inserted: 1, updated: 0, rowErrors: [] });

    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(
      () => useImportDictionaryCsv(UNIVERSE_ID),
      { wrapper: wrapperFactory(qc) },
    );

    const fakeFile = new File(['word,gloss\ntest,test'], 'test.csv', {
      type: 'text/csv',
    });

    await act(async () => {
      await result.current.mutateAsync(fakeFile);
    });

    const keys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown[] }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(['dictionary', UNIVERSE_ID]));
  });
});
