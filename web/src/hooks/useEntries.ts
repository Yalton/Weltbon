import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Severity } from './useIssues';

export interface Entry {
  id: string;
  universeId: string;
  title: string;
  entryType: string;
  summary: string;
  tags: string[];
  meta: Record<string, unknown>;
  icon: string;
  categoryId: string | null;
  /**
   * Phase 29 — SHARE-04 / D-10 / Plan 03 surface.
   * `false` by default; `true` makes the entry visible to share-link visitors
   * (Plan 04 share-read handlers filter on this column). Owner UI surfaces
   * a toggle in EntryEditor (UI-SPEC §B) and a chip on EntryDetail (UI-SPEC §C).
   * The DB column is NOT NULL (Plan 01 schema), so the field is always present
   * on every response — never optional.
   */
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundLink {
  id: string;
  targetEntryId: string;
  targetTitle: string;
  targetIcon: string;
  label: string;
  bidirectional: boolean;
}

export interface Backlink {
  id: string;
  sourceEntryId: string;
  sourceTitle: string;
  sourceIcon: string;
  label: string;
  bidirectional: boolean;
}

export interface EntryIssueRef {
  id: string;
  title: string;
  severity: Severity;
}

export interface EntryDetail extends Entry {
  body: string;
  outboundLinks: OutboundLink[];
  backlinks: Backlink[];
  /** Open (resolved=false) issues referencing this entry. Added in Plan 03-04 backend / Plan 03-09 UI. */
  issues: EntryIssueRef[];
}

export type CreateEntryInput = {
  title: string;
  entryType: string;
  summary?: string;
  body?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  icon?: string;
  categoryId?: string | null;
  /** Phase 29 SHARE-04 — defaults to false server-side; explicit on the wire so PATCH non-destructive. */
  isPublic?: boolean;
};

export type UpdateEntryInput = Partial<CreateEntryInput>;

export function useEntries(universeId: string) {
  return useQuery({
    queryKey: ['entries', universeId],
    queryFn: () => api<Entry[]>(`/universes/${universeId}/entries`),
    enabled: !!universeId,
  });
}

export function useEntry(universeId: string, entryId: string) {
  return useQuery({
    queryKey: ['entry', universeId, entryId],
    queryFn: () => api<EntryDetail>(`/universes/${universeId}/entries/${entryId}`),
    enabled: !!universeId && !!entryId,
  });
}

export function useCreateEntry(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEntryInput) =>
      api<Entry>(`/universes/${universeId}/entries`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['entries', universeId] });
    },
  });
}

export function useUpdateEntry(universeId: string, entryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateEntryInput) =>
      api<Entry>(`/universes/${universeId}/entries/${entryId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['entries', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId, entryId] });
    },
  });
}

export function useDeleteEntry(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) =>
      api<void>(`/universes/${universeId}/entries/${entryId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['entries', universeId] });
      qc.invalidateQueries({ queryKey: ['entry', universeId] });
    },
  });
}
