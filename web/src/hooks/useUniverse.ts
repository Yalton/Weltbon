import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface Universe {
  id: string;
  userId: string;
  name: string;
  description: string;
  entryTypes: string[];
  createdAt: string;
  updatedAt: string;
}

export function useUniverses() {
  return useQuery({
    queryKey: ['universes'],
    queryFn: () => api<Universe[]>('/universes'),
  });
}

export function useUniverse(id: string | undefined) {
  return useQuery({
    queryKey: ['universe', id],
    queryFn: () => api<Universe>(`/universes/${id}`),
    enabled: !!id,
  });
}

export function useCreateUniverse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; description?: string }) =>
      api<Universe>('/universes', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['universes'] }); },
  });
}

export function useUpdateUniverse(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; description?: string }) =>
      api<Universe>(`/universes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['universes'] });
      qc.invalidateQueries({ queryKey: ['universe', id] });
    },
  });
}

export function useDeleteUniverse() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/universes/${id}`, { method: 'DELETE' }),
    onSuccess: (_void, id) => {
      qc.invalidateQueries({ queryKey: ['universes'] });
      qc.removeQueries({ queryKey: ['universe', id] });
    },
  });
}
