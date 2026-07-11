import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getShareToken } from '../api/client';
import type { Calendar } from '../lib/calendarFormat';
import type { FieldRegistryEntry } from '../types/fieldRegistry';
import type { UniverseTheme } from '../types/theme';

// Phase 36 DATA-02: re-export the canonical field-registry types from the hook
// so FieldRegistrySection / MetaEditor can import them alongside Universe.
export type { FieldType, FieldRegistryEntry } from '../types/fieldRegistry';

export interface Universe {
  id: string;
  userId: string;
  name: string;
  description: string;
  entryTypes: string[];
  timelineWindow: { start: number; end: number } | null;
  // Phase 30 CALENDAR-01: per-universe fictional calendar (nullable JSONB).
  // null = no calendar defined; timeline positions display as raw numbers (CALENDAR-03).
  calendar: Calendar | null;
  createdAt: string;
  updatedAt: string;
  // Phase 24 AUDIT-03 / Phase 26 LLMUI-08: per-universe AI Gap Auditor opt-in.
  // auditEnabled=true requires both provider+model to be non-null (server-enforced).
  auditEnabled: boolean;
  auditProvider: 'anthropic' | 'openai' | null;
  auditModel: string | null;
  // Phase 35 REL-01: per-universe link-type registry (nullable until migration runs).
  // Absent on pre-migration rows → treat as empty record.
  linkTypes?: Record<string, { color?: string; directionDefault?: 'directed' | 'undirected'; inverseLabel?: string }>;
  // Phase 36 DATA-02: per-universe typed custom-field registry (nullable until migration runs).
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
  // Read from the module seam, not useShareMode(), so the gate tracks the
  // exact value whose readiness is the bug. In authenticated mode shareToken
  // is null (stable constant), so the owner cache key is unchanged.
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
      // Phase 30 CALENDAR-01: per-universe fictional calendar (nullable JSONB).
      // Pass `null` to remove (CALENDAR-03 raw-numeric revert).
      calendar?: Calendar | null;
      // Phase 26 LLMUI-08: audit opt-in patch fields (server enforces invariant
      // that auditEnabled=true → provider+model non-null).
      auditEnabled?: boolean;
      auditProvider?: 'anthropic' | 'openai' | null;
      auditModel?: string | null;
      // Phase 35 REL-01: link-type registry patch (color overrides per D-03 deferred UI).
      linkTypes?: Record<string, { color?: string; directionDefault?: 'directed' | 'undirected'; inverseLabel?: string }>;
      // Phase 36 DATA-02: full-array field-registry replace (D-03 non-destructive to entries.meta).
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
