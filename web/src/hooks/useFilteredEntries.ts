import { useQuery } from '@tanstack/react-query';
import { api, getShareToken } from '../api/client';
import type { Entry } from './useEntries';
import type { EntryFilters } from './useFilterParams';

export function buildEntriesQueryString(f: EntryFilters): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.type) p.set('type', f.type);
  f.tags.forEach((t) => p.append('tag', t));
  if (f.category) p.set('category', f.category);
  // Three-state wip: only add param when non-null
  if (f.wip !== null && f.wip !== undefined) p.set('wip', String(f.wip));
  Object.entries(f.fieldFilters ?? {}).forEach(([k, v]) => p.set(`field.${k}`, v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useFilteredEntries(universeId: string, filters: EntryFilters) {
  // HALF (b) — share-token-keyed cache + enabled gate (Gap 1 race fix):
  // Read the share token at hook-call time from the module seam (not via
  // useShareMode, which is a React context that doesn't track the module-level
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
