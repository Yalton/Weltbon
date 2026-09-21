import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

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
