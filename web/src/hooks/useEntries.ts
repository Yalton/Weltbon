import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Severity } from './useIssues';

/**
 * Phase 48 XREF-05 — response shape for the rename-propagation PATCH.
 *
 * Extends `Entry` with fields returned by the server's propagation code path:
 * - `rewriteCount`: how many wikilinks were rewritten across the universe body text.
 *   Present (even as 0) when the stale-names path was taken; omitted on the fast path.
 * - `affectedLinks` / `affectedEntries`: returned by the `?preview=true` dry-run only;
 *   both absent in the commit response.
 */
export interface EntryPatchResponse extends Entry {
  rewriteCount?: number;
  affectedLinks?: number;
  affectedEntries?: number;
}

/**
 * Phase 48 XREF-05 — write-free preview of how many links a save would rewrite.
 *
 * Calls PATCH with `?preview=true`, which returns `{ affectedLinks, affectedEntries }`
 * and writes NOTHING. Deliberately NOT a useMutation so it never triggers cache
 * invalidation (memory: react-query-key-change-blast-radius).
 */
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
  /**
   * Phase 45 — XREF-04 / D-08.
   * Alternate names for this entry. Wikilinks matching any alias resolve to
   * this entry (alias tier, D-01 precedence: title → alias → dictionary).
   * Empty array when no aliases are set.
   */
  aliases: string[];
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
  /**
   * Phase 36 — DATA-03 / Plan 03 surface.
   * `false` by default; `true` marks the entry as a work-in-progress / draft.
   * Surfaced as an amber WIP pill on EntryDetail and each entry-list card, and
   * as a toggle in EntryEditor. The DB column is NOT NULL (Plan 03 schema), so
   * the field is always present on every response — never optional on read.
   */
  wip: boolean;
  /**
   * Phase 38 — MEDIA-04 / D-06.
   * Nullable FK to the assets table. When set, the cover image renders between
   * the header block and the body markdown on EntryDetail (D-06). Null means no
   * cover image. Automatically nulled by the DB when the referenced asset is
   * deleted (ON DELETE SET NULL).
   */
  coverImageId?: string | null;
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
  /** Open (resolved=false) issues referencing this entry. Added in Plan 03-04 backend / Plan 03-09 UI. */
  issues: EntryIssueRef[];
  /**
   * Phase 38 UAT-fix: pre-signed URL for the cover image, or null if no cover.
   * Use this instead of building a URL from coverImageId — the signed URL can be
   * used directly as <img src> without Authorization: Bearer (which browsers can't
   * attach to image tag fetches).
   */
  coverImageUrl?: string | null;
  /**
   * Phase 38 UAT-fix: map of asset UUID → pre-signed raw URL for every
   * asset:// embed in this entry's body. Use these in MarkdownRenderer instead
   * of constructing /api/universes/.../assets/:id/raw paths manually.
   */
  assetUrls?: Record<string, string>;
}

export type CreateEntryInput = {
  title: string;
  entryType: string;
  summary?: string;
  body?: string;
  tags?: string[];
  /** Phase 45 XREF-04 — aliases for alternate wikilink resolution (D-07: max 20 × 100 chars). */
  aliases?: string[];
  meta?: Record<string, unknown>;
  icon?: string;
  categoryId?: string | null;
  /** Phase 29 SHARE-04 — defaults to false server-side; explicit on the wire so PATCH non-destructive. */
  isPublic?: boolean;
  /** Phase 36 DATA-03 — defaults to false server-side; explicit on the wire so PATCH non-destructive. */
  wip?: boolean;
  /** Phase 38 MEDIA-04 — nullable cover image asset id; null clears the cover. */
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
