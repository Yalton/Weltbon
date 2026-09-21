import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getShareToken } from '../api/client';
import type { Calendar } from '../lib/calendarFormat';
import type { FieldRegistryEntry } from '../types/fieldRegistry';
import type { UniverseTheme } from '../types/theme';

export type { FieldType, FieldRegistryEntry } from '../types/fieldRegistry';

export interface Universe {
  id: string;
  userId: string;
  name: string;
  description: string;
  entryTypes: string[];
  timelineWindow: { start: number; end: number } | null;
  // null = no calendar defined; timeline positions display as raw numbers (CALENDAR-03).
  calendar: Calendar | null;
  createdAt: string;
  updatedAt: string;
  // auditEnabled=true requires both provider+model to be non-null (server-enforced).
  auditEnabled: boolean;
  auditProvider: 'anthropic' | 'openai' | 'ollama' | null;
  auditModel: string | null;
  // Absent on pre-migration rows → treat as empty record.
  linkTypes?: Record<string, { color?: string; directionDefault?: 'directed' | 'undirected'; inverseLabel?: string }>;
  // Absent on pre-migration rows → treat as empty array.
  fieldRegistry?: FieldRegistryEntry[];
  // Universe theming (2026-07-10 spec). Absent on pre-migration rows.
  theme?: UniverseTheme | null;
  backdropUrl?: string | null;
  backdropThumbUrl?: string | null;
}

export function useUniverses() {
  return useQuery({
    queryKey: ['universes'],
    queryFn: () => api<Universe[]>('/universes'),
  });
}

export function useUniverse(id: string | undefined) {
  // HALF (b) — share-token-keyed cache + enabled gate (Gap 1 race fix):
  const shareToken = getShareToken();
  const shareMode = shareToken !== null;
  return useQuery({
    queryKey: ['universe', id, shareToken],
    queryFn: () => api<Universe>(`/universes/${id}`),
    enabled: !!id && (!shareMode || shareToken !== null),
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
      // Pass `null` to remove (CALENDAR-03 raw-numeric revert).
      calendar?: Calendar | null;
      // that auditEnabled=true → provider+model non-null).
      auditEnabled?: boolean;
      auditProvider?: 'anthropic' | 'openai' | 'ollama' | null;
      auditModel?: string | null;
      linkTypes?: Record<string, { color?: string; directionDefault?: 'directed' | 'undirected'; inverseLabel?: string }>;
      fieldRegistry?: FieldRegistryEntry[];
      // Universe theming (2026-07-10 spec). Whole-object replace on PATCH; null resets.
      theme?: UniverseTheme | null;
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
