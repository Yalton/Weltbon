import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface StatsEntry {
  id: string;
  title: string;
  entryType: string;
  icon: string | null;
  updatedAt: string;
}

export interface EntryTypeCount {
  type: string;
  count: number;
}

export interface CategoryCount {
  categoryId: string | null;
  label: string;
  count: number;
}

export interface Stats {
  totalEntries: number;
  totalLinks: number;
  totalTimelinePins: number;
  totalCategories: number;
  entriesByType: EntryTypeCount[];
  categoryDistribution: CategoryCount[];
  recentlyEdited: StatsEntry[];
}

export function useStats(uid: string | undefined) {
  return useQuery({
    queryKey: ['stats', uid],
    queryFn: () => api<Stats>(`/universes/${uid}/stats`),
    enabled: !!uid,
  });
}
