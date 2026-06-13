import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getShareToken } from '../api/client';
import type { Calendar } from '../lib/calendarFormat';

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
