import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export type Severity = 'critical' | 'major' | 'moderate' | 'minor';
export const SEVERITIES: readonly Severity[] = ['critical', 'major', 'moderate', 'minor'] as const;

export interface IssueEntryRef {
  id: string;
  title: string;
  icon: string;
}

export type AuditCategory =
  | 'underdeveloped'
  | 'missing-link'
  | 'contradiction'
  | 'timeline-inconsistency'
  | 'dangling-thread';

export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'underdeveloped',
  'missing-link',
  'contradiction',
  'timeline-inconsistency',
  'dangling-thread',
] as const;

export type DismissalReason =
  | 'intentional'
  | 'inaccurate'
  | 'not_now'
  | 'duplicate_of_human_issue';

export type SnoozePreset = 3 | 5 | 10 | 25;
export const SNOOZE_PRESETS: readonly SnoozePreset[] = [3, 5, 10, 25] as const;

export interface ConsultedEntryRef extends IssueEntryRef {
  updatedAt: string;
}

export interface Issue {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  entries: IssueEntryRef[];
  source?: 'human' | 'ai';
  model?: string;
  gapKey?: string;
  auditRunId?: string;
  category?: AuditCategory;
  dismissedAt?: string | null;
  dismissalReason?: DismissalReason | null;
  dismissalNotes?: string | null;
  dismissalSnoozeRemaining?: number | null;
  linkedIssueId?: string | null;
  dismissalSnapshot?: unknown;
  rationale?: string;
  costUsd?: string;
  consultedEntries?: ConsultedEntryRef[];
  linkedByAiIssueIds?: string[];
}

export interface IssueFilters {
  severity?: Severity;
  resolved?: boolean;
  source?: 'human' | 'ai';
  category?: AuditCategory[];
  includeDismissed?: boolean;
  auditRunId?: string;
}

export type CreateIssueInput = {
  title: string;
  description?: string;
  severity: Severity;
  entryIds?: string[];
};

export type UpdateIssueInput = {
  title?: string;
  description?: string;
  severity?: Severity;
  resolved?: boolean;
  entryIds?: string[];
};

export interface DismissIssuePayload {
  id: string;
  reason: DismissalReason;
  notes?: string;
  snoozeRuns?: SnoozePreset;
  linkedIssueId?: string;
}

export function useIssues(universeId: string, filters: IssueFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.severity) qs.set('severity', filters.severity);
  if (filters.resolved !== undefined) qs.set('resolved', String(filters.resolved));
  if (filters.source) qs.set('source', filters.source);
  if (filters.category && filters.category.length > 0) {
    for (const cat of filters.category) {
      qs.append('category', cat);
    }
  }
  if (filters.includeDismissed !== undefined) qs.set('includeDismissed', String(filters.includeDismissed));
  if (filters.auditRunId) qs.set('audit_run_id', filters.auditRunId);
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['issues', universeId, filters],
    queryFn: () => api<Issue[]>(`/universes/${universeId}/issues${suffix}`),
    enabled: !!universeId,
  });
}

export function useCreateIssue(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateIssueInput) =>
      api<Issue>(`/universes/${universeId}/issues`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issues', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}

export function useUpdateIssue(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateIssueInput }) =>
      api<Issue>(`/universes/${universeId}/issues/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issues', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}

export function useDeleteIssue(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/universes/${universeId}/issues/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issues', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}

export function useDismissIssue(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, notes, snoozeRuns, linkedIssueId }: DismissIssuePayload) => {
      const body: Record<string, unknown> = { reason };
      if (notes !== undefined) body.notes = notes;
      if (snoozeRuns !== undefined) body.snoozeRuns = snoozeRuns;
      if (linkedIssueId !== undefined) body.linkedIssueId = linkedIssueId;
      return api<Issue>(`/universes/${universeId}/issues/${id}/dismiss`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issues', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}

export function useUndismissIssue(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<Issue>(`/universes/${universeId}/issues/${id}/undismiss`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['issues', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}
