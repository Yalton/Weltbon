/**
 * Phase 28-05 — TanStack Query hooks for /api/templates/*.
 *
 * Wire shape (post-Plan-03 + Plan-04):
 *   GET    /api/templates            → UserTemplate[]
 *   POST   /api/templates            → UserTemplate
 *   PUT    /api/templates/:id        → UserTemplate
 *   DELETE /api/templates/:id        → 204 (void)
 *
 * The api() client (web/src/api/client.ts) prefixes /api and surfaces
 * the server's `error` string verbatim via ApiError.message.
 *
 * No optimistic updates (UI-SPEC interaction contract — template mutations
 * invalidate and refetch; server is the source of truth).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { getTemplate, type EntryTemplateMetaField } from '../lib/entryTemplates';

/**
 * A user-saved template row as returned by GET /api/templates.
 * Mirrors the DB shape from api/src/db/schema.ts entryTemplates.
 */
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

/**
 * Input body for POST /api/templates (create or clone).
 * Maps to the server's createTemplateSchema in Plan 03.
 */
export interface CreateTemplateInput {
  name: string;
  entryType: string;
  summary?: string;
  body?: string;
  meta: EntryTemplateMetaField[];
  clonedFrom?: string | null;
}

/**
 * TanStack Query hook for the current user's personal template list.
 *
 * Keyed on ['templates'] — invalidated by all mutation hooks in this file.
 * No `enabled` gate: the component renders behind ProtectedRoute.
 */
export function useTemplates() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: () => api<UserTemplate[]>('/templates'),
  });
}

/**
 * Mutation: create a new personal template.
 *
 * On success, invalidates ['templates'] so the list reflects the new row.
 * On error (including 409 name collision), bubbles the ApiError so the caller
 * can inspect err.status === 409 for the inline collision path (D-04).
 */
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

/**
 * Mutation: rename an existing personal template (PUT /templates/:id).
 *
 * On success, invalidates ['templates'].
 * On error (including 409 rename collision), bubbles the ApiError.
 */
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

/**
 * Mutation: hard-delete a personal template by id.
 *
 * On success AND on error, invalidates ['templates'].
 * A 404 error means the row was already gone (race between tabs or already
 * deleted); silently invalidating reconciles the UI without a spurious error
 * (mirrors useRevokeToken's 404-race pattern from useTokens.ts:65-80).
 */
export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: () => {
      // 404 race — silently invalidate, the row will disappear on refresh.
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}

/**
 * Mutation: clone an in-tree default template to the user's personal collection.
 *
 * Looks up the default by id via getTemplate(), then POSTs /templates with the
 * full in-tree snapshot plus clonedFrom: defaultId (D-02).
 *
 * On success, invalidates ['templates'] and returns the new UserTemplate.
 * Throws if the defaultId is not found in the in-tree TEMPLATES const.
 */
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
