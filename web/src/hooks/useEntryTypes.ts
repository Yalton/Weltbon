import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Universe } from './useUniverse';

export function useAddEntryType(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api<Universe>(`/universes/${universeId}/entry-types`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'add', name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['universe', universeId] });
    },
  });
}

export function useRenameEntryType(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { oldName: string; newName: string }) =>
      api<Universe>(`/universes/${universeId}/entry-types`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'rename', ...vars }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['universe', universeId] });
      qc.invalidateQueries({ queryKey: ['entries', universeId] });
    },
  });
}

export function useDeleteEntryType(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string; fallback?: string }) => {
      const qs = vars.fallback ? `?fallback=${encodeURIComponent(vars.fallback)}` : '';
      return api<void>(
        `/universes/${universeId}/entry-types/${encodeURIComponent(vars.name)}${qs}`,
        { method: 'DELETE' }
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['universe', universeId] });
      qc.invalidateQueries({ queryKey: ['entries', universeId] });
    },
  });
}
