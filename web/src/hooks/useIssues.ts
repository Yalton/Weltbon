import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Issue severity enum (ISS-03). Ordered from most-critical to least.
 * Defined in this module (not useEntries) to avoid the entry hook dragging
 * in the issue mutation surface; useEntries imports the type from here.
 */
export type Severity = 'critical' | 'major' | 'moderate' | 'minor';
export const SEVERITIES: readonly Severity[] = ['critical', 'major', 'moderate', 'minor'] as const;

export interface IssueEntryRef {
  id: string;
  title: string;
  icon: string;
}

/**
 * Phase 25: AI audit category vocabulary (mirrors api/src/types/audit-suggestion.ts AuditCategory).
 * Defined here (not imported from api/) to keep web/ package isolated.
 */
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

/**
 * Phase 25: Dismissal reason vocabulary (D-01). Mirrors the API's discriminated union.
 */
export type DismissalReason =
  | 'intentional'
  | 'inaccurate'
  | 'not_now'
  | 'duplicate_of_human_issue';

/**
 * Phase 25: Discrete snooze-count presets (D-02). Stored as dismissal_snooze_remaining INT.
 * Decrements on each audit run; resurfaces at 0.
 */
export type SnoozePreset = 3 | 5 | 10 | 25;
export const SNOOZE_PRESETS: readonly SnoozePreset[] = [3, 5, 10, 25] as const;

/**
 * Phase 25: Consulted entry reference with updatedAt (for dismissal snapshot comparison).
 */
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
  // Phase 25 additions — all optional so existing human-issue consumers continue to compile.
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
  /**
   * D-03 reverse-direction: populated only on HUMAN-source rows when one or more
   * AI issues have been dismissed as `duplicate_of_human_issue` with `linkedIssueId`
   * pointing at this human row. Computed server-side in the list/get projection.
   */
  linkedByAiIssueIds?: string[];
}

export interface IssueFilters {
  severity?: Severity;
  resolved?: boolean;
  // Phase 25 additions (D-10: Source + Category multi-select filter wire shape)
  source?: 'human' | 'ai';
  category?: AuditCategory[];
  includeDismissed?: boolean;
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

/**
 * Phase 25: Dismiss payload interface for useDismissIssue.
 * Body assembly omits undefined keys to satisfy the API's discriminated-union Zod schema.
 */
export interface DismissIssuePayload {
  id: string;
  reason: DismissalReason;
  notes?: string;
  snoozeRuns?: SnoozePreset;
  linkedIssueId?: string;
}

/**
 * Global issue list, filterable by severity + resolved state + source + category (Phase 25).
 * Query key includes the filters object so changing filters triggers a refetch.
 */
export function useIssues(universeId: string, filters: IssueFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.severity) qs.set('severity', filters.severity);
  if (filters.resolved !== undefined) qs.set('resolved', String(filters.resolved));
  // Phase 25 filter params (D-10)
  if (filters.source) qs.set('source', filters.source);
  if (filters.category && filters.category.length > 0) {
    for (const cat of filters.category) {
      qs.append('category', cat);
    }
  }
  if (filters.includeDismissed !== undefined) qs.set('includeDismissed', String(filters.includeDismissed));
  const suffix = qs.toString() ? `?${qs}` : '';
  return useQuery({
    queryKey: ['issues', universeId, filters],
    queryFn: () => api<Issue[]>(`/universes/${universeId}/issues${suffix}`),
    enabled: !!universeId,
  });
}

/**
 * Create an issue. Invalidates both ['issues', universeId] (global list) and
 * the ['entry', universeId] prefix so any open EntryDetail refetches its
 * embedded issues array.
 */
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

/**
 * Update an issue by id. Uses `{ id, patch }` at mutate time (rather than
 * binding issueId at hook-creation time) so a single hook instance in a list
 * view can patch any row the user interacts with. Mirrors useUpdateCategory.
 */
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

/**
 * Delete an issue (hard delete — cascades to issue_entries via FK). Invalidates
 * both the global issue list and any EntryDetail referencing it.
 */
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

/**
 * Phase 25: Dismiss an AI-sourced issue with a structured reason (D-01).
 * POSTs to /universes/:uid/issues/:id/dismiss.
 * Body omits undefined keys to satisfy the API's discriminated-union Zod schema.
 * Invalidates ['issues', universeId] + ['entry', universeId] on success.
 */
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

/**
 * Phase 25: Restore a dismissed AI-sourced issue (D-13: action label "Restore").
 * POSTs to /universes/:uid/issues/:id/undismiss with no body.
 * Clears all dismissal columns; the gap_key re-enters the active pool on the next audit run.
 * Invalidates ['issues', universeId] + ['entry', universeId] on success.
 */
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
