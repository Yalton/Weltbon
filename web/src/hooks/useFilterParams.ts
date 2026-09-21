import { useSearchParams } from 'react-router-dom';
import { useCallback, useMemo } from 'react';

export interface EntryFilters {
  q: string;
  type: string | null;
  tags: string[];
  category: string | null;
  wip: boolean | null;
  fieldFilters: Record<string, string>;
}

export function useFilterParams(): [EntryFilters, (patch: Partial<EntryFilters>) => void] {
  const [params, setParams] = useSearchParams();

  const filters: EntryFilters = useMemo(
    () => {
      const fieldFilters: Record<string, string> = {};
      params.forEach((value, key) => {
        if (key.startsWith('field.')) {
          fieldFilters[key.slice('field.'.length)] = value;
        }
      });

      // Decode three-state wip: "true" → true, "false" → false, absent → null
      const wipParam = params.get('wip');
      const wip = wipParam === 'true' ? true : wipParam === 'false' ? false : null;

      return {
        q: params.get('q') ?? '',
        type: params.get('type'),
        tags: params.getAll('tag'),
        category: params.get('category'),
        wip,
        fieldFilters,
      };
    },
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
          // Three-state wip: set 'true'/'false' when boolean, delete when null
          if ('wip' in patch) {
            if (patch.wip === null || patch.wip === undefined) {
              next.delete('wip');
            } else {
              next.set('wip', String(patch.wip));
            }
          }
          // then set each new key (mirrors the tags delete-all-then-append).
          if ('fieldFilters' in patch) {
            const keysToDelete: string[] = [];
            next.forEach((_value, key) => {
              if (key.startsWith('field.')) keysToDelete.push(key);
            });
            keysToDelete.forEach((k) => next.delete(k));
            Object.entries(patch.fieldFilters ?? {}).forEach(([k, v]) => {
              next.set(`field.${k}`, v);
            });
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
