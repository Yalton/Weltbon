import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Entry } from './useEntries';
import type { EntryFilters } from './useFilterParams';

/**
 * Build the query string for the filtered /entries endpoint from an
 * EntryFilters object. Empty filters produce an empty string (no `?`) so the
 * URL collapses to the same shape the unfiltered useEntries uses — the
 * backend treats both identically.
 */
export function buildEntriesQueryString(f: EntryFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.type) p.set('type', f.type);
  f.tags.forEach((t) => p.append('tag', t));
  if (f.category) p.set('category', f.category);
  // Three-state wip: only add param when non-null
  if (f.wip !== null && f.wip !== undefined) p.set('wip', String(f.wip));
  // Field filters: ?field.{name}={value} for each entry (AND semantics)
  Object.entries(f.fieldFilters ?? {}).forEach(([k, v]) => p.set(`field.${k}`, v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * TanStack Query hook for the entry list, keyed on the full filter object so
 * any change (tag added, search typed) triggers a refetch automatically.
 *
 * The unfiltered useEntries(universeId) hook is kept exported untouched —
 * Sidebar counts + Graph view still consume it, so we do not want this
 * variant's cache to collide with theirs (different key prefix entries
 * identifies the filtered branch distinctly from the bare list).
 */
export function useFilteredEntries(universeId: string, filters: EntryFilters) {
  return useQuery({
    queryKey: ['entries', universeId, filters],
    queryFn: () =>
      api<Entry[]>(`/universes/${universeId}/entries${buildEntriesQueryString(filters)}`),
    enabled: !!universeId,
  });
}
