import { useQuery } from '@tanstack/react-query';
import { api, getShareToken } from '../api/client';
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
  // HALF (b) — share-token-keyed cache + enabled gate (Gap 1 race fix):
  // Read the share token at hook-call time from the module seam (not via
  // useShareMode, which is a React context that doesn't track the module-level
  // shareTokenPlaintext used by the api seam). In authenticated mode
  // shareToken is the stable constant null, so the owner cache key is
  // behaviorally unchanged. In share mode the token becomes part of the key so
  // a null-token (transient StrictMode clear) and a ready-token attempt occupy
  // DISTINCT cache slots — a cached null-token 404 can never be read back as
  // the ready-token result. The enabled guard withholds the query in share mode
  // until the token is present, eliminating the null-token fetch window.
  const shareToken = getShareToken();
  const shareMode = shareToken !== null;
  return useQuery({
    queryKey: ['entries', universeId, filters, shareToken],
    queryFn: () =>
      api<Entry[]>(`/universes/${universeId}/entries${buildEntriesQueryString(filters)}`),
    enabled: !!universeId && (!shareMode || shareToken !== null),
  });
}
