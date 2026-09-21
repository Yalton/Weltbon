import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Severity } from './useIssues';

export interface EntryPatchResponse extends Entry {
  rewriteCount?: number;
  affectedLinks?: number;
  affectedEntries?: number;
}

export async function fetchEntryDetail(
  universeId: string,
  entryId: string,
): Promise<EntryDetail> {
  return api<EntryDetail>(`/universes/${universeId}/entries/${entryId}`);
}

export async function previewEntryUpdate(
  universeId: string,
  entryId: string,
  body: UpdateEntryInput,
): Promise<Pick<EntryPatchResponse, 'affectedLinks' | 'affectedEntries'>> {
  return api<Pick<EntryPatchResponse, 'affectedLinks' | 'affectedEntries'>>(
    `/universes/${universeId}/entries/${entryId}?preview=true`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}

export interface Entry {
  id: string;
  universeId: string;
  title: string;
  entryType: string;
  summary: string;
  tags: string[];
  aliases: string[];
  meta: Record<string, unknown>;
  icon: string;
  categoryId: string | null;
  isPublic: boolean;
  wip: boolean;
  coverImageId?: string | null;
  /**
   * Content-Forward Views §1.1.
   * Pre-signed thumb URL for the cover, or null (no cover, or the asset is gone — the
   * projection is dangling-tolerant). Use this rather than building a URL from
   * coverImageId: browsers cannot attach an Authorization header to an <img src>, so only
   * the signed URL loads.
   *
   * LIST-ONLY. The API declares it on a list-specific schema — create/patch/detail do NOT
   * return it (detail has its own `coverImageUrl`, the full-size raw URL). Hence optional.
   * Present on both the authenticated and the share list — API-side parity is enforced by
   * a key-set tripwire test.
   */
  coverThumbUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundLink {
  id: string;
  targetEntryId: string;
  targetTitle: string;
  targetIcon: string;
  label: string | null;
  linkType: string | null;
  direction: string;
}

export interface Backlink {
  id: string;
  sourceEntryId: string;
  sourceTitle: string;
  sourceIcon: string;
  label: string | null;
  linkType: string | null;
  direction: string;
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
  issues: EntryIssueRef[];
  /**
   * Use this instead of building a URL from coverImageId — the signed URL can be
   * used directly as <img src> without Authorization: Bearer (which browsers can't
   * attach to image tag fetches).
   */
  coverImageUrl?: string | null;
  assetUrls?: Record<string, string>;
}

export type CreateEntryInput = {
  title: string;
  entryType: string;
  summary?: string;
  body?: string;
  tags?: string[];
  aliases?: string[];
  meta?: Record<string, unknown>;
  icon?: string;
  categoryId?: string | null;
  isPublic?: boolean;
  wip?: boolean;
  coverImageId?: string | null;
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
      api<EntryPatchResponse>(`/universes/${universeId}/entries/${entryId}`, {
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
