import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { EntryTemplate } from '../lib/entryTemplates';

// Phase 29 DATA-02: universe-scoped typed custom-field registry.
// Never per-entry-type (T1 line to hold). Globally applied to every entry editor.
export interface FieldRegistryEntry {
  name: string;
  type: 'text' | 'number' | 'boolean' | 'url' | 'entry-ref';
  hint?: string;
}

export interface Universe {
  id: string;
  userId: string;
  name: string;
  description: string;
  entryTypes: string[];
  timelineWindow: { start: number; end: number } | null;
  createdAt: string;
  updatedAt: string;
  // Phase 24 AUDIT-03 / Phase 26 LLMUI-08: per-universe AI Gap Auditor opt-in.
  // auditEnabled=true requires both provider+model to be non-null (server-enforced).
  auditEnabled: boolean;
  auditProvider: 'anthropic' | 'openai' | null;
  auditModel: string | null;
  // Phase 28 D-11/D-12: per-universe persisted entry templates (DB-backed).
  // Built-in TEMPLATES/TEMPLATE_GROUPS are additive and unmodified.
  entryTemplates: EntryTemplate[];
  // Phase 28 REL-02: link-type color/direction registry consumed by GraphCanvas + RelationLegend.
  linkTypes: Record<string, { color?: string; directionDefault?: 'directed' | 'undirected'; inverseLabel?: string }>;
  // Phase 29 DATA-02: custom-field registry (universe-scoped, globally typed — D-01..D-03).
  fieldRegistry: FieldRegistryEntry[];
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
    mutationFn: (body: {
      name?: string;
      description?: string;
      timelineWindow?: { start: number; end: number } | null;
      // Phase 26 LLMUI-08: audit opt-in patch fields (server enforces invariant
      // that auditEnabled=true → provider+model non-null).
      auditEnabled?: boolean;
      auditProvider?: 'anthropic' | 'openai' | null;
      auditModel?: string | null;
      // Phase 28 D-11: full entryTemplates array replace (max 50 server-enforced).
      entryTemplates?: EntryTemplate[];
      // Phase 28 REL-02: link-type registry patch.
      linkTypes?: Record<string, { color?: string; directionDefault?: 'directed' | 'undirected'; inverseLabel?: string }>;
      // Phase 29 DATA-02: field registry full-array replace (mirrors entryTemplates pattern).
      fieldRegistry?: FieldRegistryEntry[];
    }) =>
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
