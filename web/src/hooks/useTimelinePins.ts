import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Timeline pin shape returned by GET /universes/:uid/timeline.
 *
 * Joined entry fields (entryTitle/entryIcon/entryType) are populated by the
 * backend so /timeline can render entry context without a second fetch.
 * They mirror the TimelinePin in lib/groupByEra so callers can pass API rows
 * directly to groupByEra().
 */
export interface TimelinePin {
  id: string;
  entryId: string;
  label: string;
  position: number;
  precision: 'exact' | 'approximate' | 'era';
  entryTitle?: string;
  entryIcon?: string;
  entryType?: string;
}

export interface UpsertPinInput {
  entryId: string;
  label: string;
  position: number;
  precision: 'exact' | 'approximate' | 'era';
}

/**
 * GET /timeline — full pin list for the universe, sorted ASC by position
 * server-side. Used by both TimelineView (the /timeline page) and
 * TimelinePinSection (per-entry section, lookup by entryId).
 */
export function useTimelinePins(universeId: string) {
  return useQuery({
    queryKey: ['timeline', universeId],
    queryFn: () => api<TimelinePin[]>(`/universes/${universeId}/timeline`),
    enabled: !!universeId,
  });
}

/**
 * POST /entries/:entryId/pin — upsert by entryId (UNIQUE on entry_id).
 * Invalidates ['timeline', universeId] (for the TimelineView list) AND
 * ['entry', universeId] (for any open EntryDetail) — matches Phase 2
 * link-mutation invalidation pattern.
 */
export function useUpsertTimelinePin(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ entryId, ...body }: UpsertPinInput) =>
      api<TimelinePin>(`/universes/${universeId}/entries/${entryId}/pin`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timeline', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}

/**
 * DELETE /entries/:entryId/pin — same invalidations as upsert.
 */
export function useDeleteTimelinePin(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) =>
      api<void>(`/universes/${universeId}/entries/${entryId}/pin`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timeline', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}
