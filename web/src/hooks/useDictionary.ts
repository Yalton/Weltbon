import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';


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

export function useUniverseDictionary(universeId: string) {
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

  // null-scope (index 0, loaded first) takes priority; language-scoped rows
  const words: DictionaryWord[] = [];
  for (const q of dictQueries) {
    if (q.data) words.push(...q.data);
  }

  return { words, isLoading, isError };
}
