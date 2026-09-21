import { useUniverse, useUpdateUniverse, type Universe } from './useUniverse';

export interface TimelineWindow {
  start: number;
  end: number;
}

export function useTimelineWindow(universeId: string): {
  window: TimelineWindow | null;
  setWindow: (w: TimelineWindow | null) => Promise<Universe>;
  isLoading: boolean;
  isPending: boolean;
} {
  const query = useUniverse(universeId);
  const update = useUpdateUniverse(universeId);
  return {
    window: query.data?.timelineWindow ?? null,
    setWindow: (w) => update.mutateAsync({ timelineWindow: w }),
    isLoading: query.isLoading,
    isPending: update.isPending,
  };
}
