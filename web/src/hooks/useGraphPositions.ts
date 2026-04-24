import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Mutations for graph position persistence.
 *
 * POST /universes/:uid/graph-positions — upsert a pin for a single entry.
 * DELETE /universes/:uid/graph-positions — clear every pin in the universe.
 *
 * Both invalidate the ['graph-data', universeId] query so the next render
 * pulls the fresh positions array alongside the nodes + edges.
 */

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
