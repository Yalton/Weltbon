import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';


export interface PinNodeInput {
  entryId: string;
  x: number;
  y: number;
}

export function usePinNode(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PinNodeInput) =>
      api<{ entryId: string; x: number; y: number }>(
        `/universes/${universeId}/graph-positions`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['graph-data', universeId] });
    },
  });
}

export function useResetGraphLayout(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<void>(`/universes/${universeId}/graph-positions`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['graph-data', universeId] });
    },
  });
}
