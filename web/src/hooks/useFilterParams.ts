import { useSearchParams } from 'react-router-dom';
import { useCallback, useMemo } from 'react';

/**
 * Shape of the URL-backed entry filters.
 *
 * - q: free-text search string (maps to ?q=)
 * - type: entryType filter (maps to ?type=)
 * - tags: AND-semantics tag list (maps to repeated ?tag=)
 * - category: category uuid, or the literal string 'uncategorized' for the
 *   NULL-category bucket (maps to ?category=)
 */
export interface EntryFilters {
  q: string;
  type: string | null;
  tags: string[];
  category: string | null;
}

/**
 * Typed wrapper around react-router's useSearchParams that projects the URL
 * into an EntryFilters object and exposes a partial-patch updater. Writes
 * use `replace: true` so typing in the search box does not flood browser
 * history with one entry per keystroke.
 */
export function useFilterParams(): [EntryFilters, (patch: Partial<EntryFilters>) => void] {
  const [params, setParams] = useSearchParams();

  const filters: EntryFilters = useMemo(
    () => ({
      q: params.get('q') ?? '',
      type: params.get('type'),
      tags: params.getAll('tag'),
      category: params.get('category'),
    }),
    [params],
  );

  const update = useCallback(
    (patch: Partial<EntryFilters>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if ('q' in patch) {
            if (patch.q) next.set('q', patch.q);
            else next.delete('q');
          }
          if ('type' in patch) {
            if (patch.type) next.set('type', patch.type);
            else next.delete('type');
          }
          if ('tags' in patch) {
            next.delete('tag');
            (patch.tags ?? []).forEach((t) => next.append('tag', t));
          }
          if ('category' in patch) {
            if (patch.category) next.set('category', patch.category);
            else next.delete('category');
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return [filters, update];
}
