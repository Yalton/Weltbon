import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Universe } from './useUniverse';

/**
 * Add a new entry-type label to the universe.entry_types array.
 * Backend (Plan 05-03) validates uniqueness; 409 duplicate_type on collision.
 */
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

/**
 * Rename an entry-type. Cascades inside a single transaction to all entries
 * whose entry_type matches oldName. Invalidates both the universe and entries
 * caches so the new name appears everywhere immediately.
 */
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

/**
 * Delete an entry-type. Without `fallback`, backend returns 409
 * entries_using_type {count, type} when entries reference the type. With
 * `fallback`, the deletion happens in a transaction that reassigns those
 * entries to the fallback first.
 */
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
