import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Event pin shape returned by GET /universes/:uid/timeline.
 *
 * Events in Weltbon are ordinary timeline pins whose underlying entry has
 * type='event'.  The list endpoint returns joined entry fields so
 * EventsView can render context without a second fetch.
 *
 * MEMORY WARNING (Phase 30 D-02): this hook adds a NEW ['events'] query key.
 * Do NOT re-key ['timeline'] — that would break sibling exact-key cache ops
 * and per-file api/client mocks.
 */
export interface EventPin {
  id: string;
  entryId: string;
  label: string;
  position: number;
  precision: 'exact' | 'approximate' | 'era';
  entryTitle?: string;
  entryIcon?: string;
  entryType?: string;
}

export interface EventFilters {
  participantId?: string;
  fromPosition?: number;
  toPosition?: number;
}

export interface AddEventInput {
  title: string;
  description?: string;
  position: number;
  precision?: 'exact' | 'approximate' | 'era';
  label?: string;
}

/**
 * GET /universes/:uid/timeline (with optional filters) — chronological event list.
 * Keyed ['events', universeId, filters] — a NEW key, NOT a re-key of ['timeline'].
 */
export function useEvents(universeId: string, filters?: EventFilters) {
  // Build query string from non-undefined filter values.
  const qs = (() => {
    const params = new URLSearchParams();
    if (filters?.participantId) params.set('participantId', filters.participantId);
    if (filters?.fromPosition !== undefined)
      params.set('fromPosition', String(filters.fromPosition));
    if (filters?.toPosition !== undefined)
      params.set('toPosition', String(filters.toPosition));
    const s = params.toString();
    return s ? `?${s}` : '';
  })();

  return useQuery({
    queryKey: ['events', universeId, filters ?? {}],
    queryFn: () =>
      api<EventPin[]>(`/universes/${universeId}/timeline${qs}`),
    enabled: !!universeId,
  });
}

/**
 * POST /universes/:uid/events — atomically creates an entry (type='event') +
 * its timeline pin in a single server-side transaction (Plan 04 D-10).
 *
 * On success invalidates:
 *   - ['timeline', universeId]  — so TimelineView / TimelinePinSection refresh
 *   - ['entries', universeId]   — so EntryList reflects the new event entry
 *   - ['events', universeId]    — so EventsView refreshes (all filter combos)
 */
export function useAddEvent(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddEventInput) =>
      api<{ entry: { id: string }; pin: EventPin }>(
        `/universes/${universeId}/events`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['timeline', universeId] });
      qc.invalidateQueries({ queryKey: ['entries', universeId] });
      qc.invalidateQueries({ queryKey: ['events', universeId] });
    },
  });
}
