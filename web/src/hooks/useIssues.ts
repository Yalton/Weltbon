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

export interface Issue {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  entries: IssueEntryRef[];
}

export interface IssueFilters {
  severity?: Severity;
  resolved?: boolean;
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
 * Global issue list, filterable by severity + resolved state.
 * Query key includes the filters object so changing filters triggers a refetch.
 */
export function useIssues(universeId: string, filters: IssueFilters = {}) {
  const qs = new URLSearchParams();
  if (filters.severity) qs.set('severity', filters.severity);
  if (filters.resolved !== undefined) qs.set('resolved', String(filters.resolved));
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
