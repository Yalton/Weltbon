import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DictionaryWord {
  id: string;
  universeId: string;
  languageEntryId: string | null;
  word: string;
  ipa: string;
  partOfSpeech: string;
  gloss: string;
  etymology: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DictionaryFilters {
  q: string;
  lid: string | null; // language entry id; null = universe-level fallback (D-07)
}

export interface ImportResult {
  inserted: number;
  updated: number;
  rowErrors: { row: number; message: string }[];
}

export interface CreateWordInput {
  word: string;
  gloss: string;
  ipa?: string;
  partOfSpeech?: string;
  etymology?: string;
  tags?: string[];
  languageEntryId: string | null;
}

export type UpdateWordInput = Partial<Omit<CreateWordInput, 'languageEntryId'>>;

// ─── Hooks ───────────────────────────────────────────────────────────────────

/**
 * Filter-keyed list hook (D-13).
 *
 * Query key includes the full filter object so any change to q or lid triggers
 * a server refetch. The server applies FTS for ?q= and scope for ?lid=.
 * Client-side sort/facet (pos, tag) are applied in DictionaryTable.
 *
 * Mirrors useFilteredEntries — cache-key design per project memory:
 * react-query-key-change-blast-radius (per-file api mock; exact key ops).
 */
export function useFilteredDictionary(
  universeId: string,
  filters: DictionaryFilters,
) {
  return useQuery({
    queryKey: ['dictionary', universeId, filters],
    queryFn: () => {
      const p = new URLSearchParams();
      if (filters.q) p.set('q', filters.q);
      if (filters.lid) p.set('lid', filters.lid);
      const qs = p.toString();
      return api<DictionaryWord[]>(
        `/universes/${universeId}/dictionary${qs ? `?${qs}` : ''}`,
      );
    },
    enabled: !!universeId,
  });
}

/**
 * Create a new word (POST /universes/:uid/dictionary).
 * Invalidates the ['dictionary', universeId] prefix so all filter variants
 * refetch.
 */
export function useCreateWord(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWordInput) =>
      api<DictionaryWord>(`/universes/${universeId}/dictionary`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionary', universeId] });
    },
  });
}

/**
 * Update an existing word (PATCH /universes/:uid/dictionary/:wid).
 * Invalidates the ['dictionary', universeId] prefix.
 */
export function useUpdateWord(universeId: string, wordId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWordInput) =>
      api<DictionaryWord>(
        `/universes/${universeId}/dictionary/${wordId}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionary', universeId] });
    },
  });
}

/**
 * Delete a word (DELETE /universes/:uid/dictionary/:wid).
 * Invalidates the ['dictionary', universeId] prefix.
 */
export function useDeleteWord(universeId: string, wordId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<void>(`/universes/${universeId}/dictionary/${wordId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionary', universeId] });
    },
  });
}

/**
 * Bulk-import words from a CSV file.
 * Posts multipart FormData to /universes/:uid/dictionary/import.
 * If `lid` is provided, appends ?lid=<lid> so the import targets the
 * language-scoped dictionary rather than the universe-level fallback (CR-01).
 * Returns { inserted, updated, rowErrors[] }.
 * Invalidates the ['dictionary', universeId] prefix on success.
 */
export function useImportDictionaryCsv(universeId: string, lid?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      const qs = lid ? `?lid=${encodeURIComponent(lid)}` : '';
      return api<ImportResult>(
        `/universes/${universeId}/dictionary/import${qs}`,
        {
          method: 'POST',
          body: formData,
        },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dictionary', universeId] });
    },
  });
}

/**
 * Fetch language-type entries for the universe — used to populate the
 * language switcher in the Dictionary view.
 *
 * Returns only entries of type 'language'; the server-side ?type= filter is
 * applied so we get a small targeted list without fetching all entries.
 */
export function useLanguageEntries(universeId: string) {
  return useQuery({
    queryKey: ['language-entries', universeId],
    queryFn: () =>
      api<{ id: string; title: string }[]>(
        `/universes/${universeId}/entries?type=language`,
      ),
    enabled: !!universeId,
  });
}

/**
 * Phase 32 Plan 04 — D-02 universe-wide dictionary union.
 *
 * Used by EntryDetail when the entry links NO language entry. The server-side
 * GET /dictionary endpoint returns only the null-scoped fallback when no `lid`
 * is provided. To build the UNION of ALL dictionaries in the universe (all
 * language dicts + null-scope fallback), we:
 *   1. Fetch the language-entries list to get each language's id.
 *   2. Issue one query per language dict (lid=<id>) + one for the null-scope
 *      fallback (lid=null).
 *   3. Merge all rows into a single lower(word)→DictionaryWord map. On
 *      spelling collision, first encountered wins (acceptable per D-02).
 *
 * In share mode the api-client seam rewrites these fetches to
 * /api/share/dictionary?lid=... — only public words enter the map (T-32-11).
 *
 * Returns: { words: DictionaryWord[], isLoading, isError }
 */
export function useUniverseDictionary(universeId: string) {
  // Step 1: get language entries (already cached from Dictionary view)
  const { data: langEntries, isPending: langPending, isError: langError } = useLanguageEntries(universeId);

  // Step 2: dynamic parallel queries — one per language + one for null-scope
  // useQueries with a static config per available lang + the null-scope entry.
  // We represent null-scope as lid='' in the query params (no lid param sent).
  const lidList: Array<string | null> = [
    null, // null-scope fallback
    ...(langEntries ?? []).map((e) => e.id),
  ];

  const dictQueries = useQueries({
    queries: lidList.map((lid) => ({
      queryKey: ['dictionary', universeId, { q: '', lid }] as const,
      queryFn: () => {
        const p = new URLSearchParams();
        if (lid) p.set('lid', lid);
        const qs = p.toString();
        return api<DictionaryWord[]>(
          `/universes/${universeId}/dictionary${qs ? `?${qs}` : ''}`,
        );
      },
      enabled: !!universeId && !langPending && !langError,
      staleTime: 30_000,
    })),
  });

  const isLoading = langPending || dictQueries.some((q) => q.isPending);
  const isError = langError || dictQueries.some((q) => q.isError);

  // Merge all rows into a single lower(word)→DictionaryWord map. On collision,
  // null-scope (index 0, loaded first) takes priority; language-scoped rows
  // fill in the rest. Order is deterministic by lidList iteration order.
  const words: DictionaryWord[] = [];
  for (const q of dictQueries) {
    if (q.data) words.push(...q.data);
  }

  return { words, isLoading, isError };
}
