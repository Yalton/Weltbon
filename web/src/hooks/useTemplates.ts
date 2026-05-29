import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * A user-saved template row as returned by GET /api/templates.
 */
export interface Template {
  id: string;
  name: string;
  entryType: string;
  summary: string;
  body: string;
  meta: Array<{ name: string; default_value: string }>;
  clonedFrom: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTemplateInput {
  name: string;
  entryType: string;
  summary: string;
  body: string;
  meta: Array<{ name: string; default_value: string }>;
  clonedFrom?: string;
}

/**
 * TanStack Query hook for the current user's saved templates list.
 *
 * Keyed on ['templates'] — invalidated by create/rename/delete mutations.
 */
export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: () => api<Template[]>('/templates'),
  });
}

/**
 * Mutation: save a new template from the current entry's structure.
 *
 * On success, invalidates ['templates'] so the picker reflects the new row.
 */
export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTemplateInput) =>
      api<Template>('/templates', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}

/**
 * Mutation: rename a personal template.
 *
 * On success, invalidates ['templates'] so the list reflects the renamed row.
 */
export function useRenameTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      api<Template>(`/templates/${vars.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: vars.name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}

/**
 * Mutation: delete a personal template by id.
 *
 * On success AND on error, invalidates ['templates'].
 * A 404 error means the row was already gone (race); silently invalidating
 * reflects truth in the UI without surfacing a spurious error.
 */
export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
    onError: () => {
      // 404 race — silently invalidate, the row will disappear on refresh
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}

/**
 * Mutation: clone an in-tree default template to the user's personal templates.
 *
 * The clonedFrom field records the in-tree default id (D-02).
 */
export function useCloneDefaultTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTemplateInput & { clonedFrom: string }) =>
      api<Template>('/templates', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}
