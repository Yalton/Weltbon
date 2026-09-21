
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { getTemplate, type EntryTemplateMetaField } from '../lib/entryTemplates';

export interface UserTemplate {
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
  summary?: string;
  body?: string;
  meta: EntryTemplateMetaField[];
  clonedFrom?: string | null;
}

export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: () => api<UserTemplate[]>('/templates'),
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTemplateInput) =>
      api<UserTemplate>('/templates', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}

export function useRenameTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      api<UserTemplate>(`/templates/${vars.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: vars.name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        qc.invalidateQueries({ queryKey: ['templates'] });
      }
    },
  });
}

export function useCloneDefaultTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (defaultId: string) => {
      const d = getTemplate(defaultId);
      if (!d) throw new Error(`No in-tree template with id "${defaultId}"`);
      return api<UserTemplate>('/templates', {
        method: 'POST',
        body: JSON.stringify({
          name: d.label,
          entryType: d.entryType,
          summary: d.summary,
          body: d.body,
          meta: d.meta,
          clonedFrom: defaultId,
        } satisfies CreateTemplateInput),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}
