import { useUniverse, useUpdateUniverse, type Universe } from './useUniverse';
import type { Calendar } from '../lib/calendarFormat';

export function useCalendar(universeId: string): {
  calendar: Calendar | null;
  setCalendar: (c: Calendar | null) => Promise<Universe>;
  isLoading: boolean;
  isPending: boolean;
} {
  const query = useUniverse(universeId);
  const update = useUpdateUniverse(universeId);
  return {
    calendar: query.data?.calendar ?? null,
    setCalendar: (c) => update.mutateAsync({ calendar: c }),
    isLoading: query.isLoading,
    isPending: update.isPending,
  };
}
