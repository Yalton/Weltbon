import { useMemo } from 'react';
import { useEntries } from './useEntries';
import type { MedallionSource } from '../lib/medallion';

/**
 * Content-Forward Views — the single cover seam for the canvas views.
 *
 * The graph (/graph-data), the timeline (/timeline/pins) and the map (/maps/:id) each have
 * their own projection, and none of them carries a cover. Rather than adding the field to
 * all three AND their three share twins — six projections to keep in parity forever, when
 * "the share projection drifted from the auth projection" is a bug this repo has already
 * shipped twice — every canvas resolves its identity art from the entries LIST cache,
 * which already has it.
 *
 * Reads useEntries' existing query key: no new key, no second request, no cache blast
 * radius (see the react-query-key-change-blast-radius lesson). Share mode needs no branch —
 * the api-client seam rewrites the path, and the share list is public-filtered server-side,
 * so a private entry's cover never enters the map.
 */
export function useEntryMedallions(universeId: string): Map<string, MedallionSource> {
  const { data } = useEntries(universeId);

  return useMemo(() => {
    const map = new Map<string, MedallionSource>();
    for (const e of data ?? []) {
      map.set(e.id, {
        title: e.title,
        entryType: e.entryType,
        icon: e.icon,
        coverThumbUrl: e.coverThumbUrl ?? null,
      });
    }
    return map;
  }, [data]);
}
