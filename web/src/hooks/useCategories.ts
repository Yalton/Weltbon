import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getShareToken } from '../api/client';

export interface Category {
  id: string;
  label: string;
  icon: string;
  sortOrder: number;
  entryCount: number;
}

export interface CategoryListResponse {
  categories: Category[];
  uncategorizedCount: number;
}

/**
 * TanStack Query hook for the universe-scoped category list.
 *
 * Keyed on ['categories', universeId, shareToken] so mutations on categories
 * (Plan 07 drag-to-reorder, create/rename) can invalidate precisely, AND so
 * a transient null-token (StrictMode clear) cache entry cannot be read back as
 * the ready-token result. See Gap 1 race fix (half b) in 29-08-PLAN.md.
 * In authenticated mode shareToken is the stable constant null, so the owner
 * cache key ['categories', universeId, null] is behaviorally unchanged.
 */
export function useCategories(universeId: string) {
  // HALF (b) — share-token-keyed cache + enabled gate (Gap 1 race fix):
  const shareToken = getShareToken();
  const shareMode = shareToken !== null;
  return useQuery({
    queryKey: ['categories', universeId, shareToken],
    queryFn: () => api<CategoryListResponse>(`/universes/${universeId}/categories`),
    enabled: !!universeId && (!shareMode || shareToken !== null),
  });
}

export type CreateCategoryInput = {
  label: string;
  icon?: string;
};

export type UpdateCategoryInput = {
  label?: string;
  icon?: string;
};

/**
 * Create a new category in a universe. Invalidates ['categories', universeId]
 * on success so the sidebar reflects the new row + count.
 */
export function useCreateCategory(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCategoryInput) =>
      api<Category>(`/universes/${universeId}/categories`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories', universeId] });
    },
  });
}

/**
 * Rename / re-emoji an existing category. Takes { id, patch } so a single
 * hook instance can update any category in the universe.
 */
export function useUpdateCategory(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateCategoryInput }) =>
      api<Category>(`/universes/${universeId}/categories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories', universeId] });
    },
  });
}

/**
 * Delete a category. Entries in that category fall back to uncategorized
 * (FK onDelete: set null). Invalidates both categories and entries prefixes
 * so affected entry rows re-render without a stale categoryId.
 */
export function useDeleteCategory(universeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/universes/${universeId}/categories/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories', universeId] });
      qc.invalidateQueries({ queryKey: ['entries', universeId] });
    },
  });
}

/**
 * Reorder categories (drag & drop). Takes the new ordered id list.
 *
 * Optimistic: the sidebar cache is rewritten in onMutate so the drop is
 * instant visually. On error the previous snapshot is restored. onSettled
 * always invalidates to reconcile with the server-computed sortOrder values.
 */
export function useReorderCategories(universeId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, string[], { prev: CategoryListResponse | undefined }>({
    mutationFn: (orderedIds: string[]) =>
      api<void>(`/universes/${universeId}/categories/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ orderedIds }),
      }),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey: ['categories', universeId] });
      const prev = qc.getQueryData<CategoryListResponse>(['categories', universeId]);
      if (prev) {
        const byId = new Map(prev.categories.map((c) => [c.id, c]));
        const reordered = orderedIds
          .map((id, i) => {
            const existing = byId.get(id);
            return existing ? { ...existing, sortOrder: i } : null;
          })
          .filter((c): c is Category => c !== null);
        qc.setQueryData<CategoryListResponse>(['categories', universeId], {
          ...prev,
          categories: reordered,
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(['categories', universeId], ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['categories', universeId] });
    },
  });
}
