import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

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
 * Keyed on ['categories', universeId] so mutations on categories (Plan 07
 * drag-to-reorder, create/rename) can invalidate precisely.
 */
export function useCategories(universeId: string) {
  return useQuery({
    queryKey: ['categories', universeId],
    queryFn: () => api<CategoryListResponse>(`/universes/${universeId}/categories`),
    enabled: !!universeId,
  });
}
