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
 * - wip: three-state WIP filter — null (all), true (WIP only), false (finished only)
 *   (maps to ?wip=true / ?wip=false; absent = null)
 * - fieldFilters: exact-match meta-field filters keyed by field name
 *   (maps to repeated ?field.{name}={value} — dot-notation, AND semantics)
 */
export interface EntryFilters {
  q: string;
  type: string | null;
  tags: string[];
  category: string | null;
  /** Three-state: null = show all, true = WIP only, false = finished only */
  wip: boolean | null;
  /** Exact-match field filters — keys are field names, values are filter values */
  fieldFilters: Record<string, string>;
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
    () => {
      // Decode fieldFilters: iterate all params whose name starts with "field.",
      // strip the prefix to produce the key.
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
          // fieldFilters: full replace — delete all existing field.* params first,
          // then set each new key (mirrors the tags pattern: delete-all then append).
          if ('fieldFilters' in patch) {
            // Delete all existing field.* params
            const keysToDelete: string[] = [];
            next.forEach((_value, key) => {
              if (key.startsWith('field.')) keysToDelete.push(key);
            });
            keysToDelete.forEach((k) => next.delete(k));
            // Set new field.* params
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
