import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

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

export function useTimelinePins(universeId: string) {
  return useQuery({
    queryKey: ['timeline', universeId],
    queryFn: () => api<TimelinePin[]>(`/universes/${universeId}/timeline`),
    enabled: !!universeId,
  });
}

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
