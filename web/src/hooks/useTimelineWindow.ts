import { useUniverse, useUpdateUniverse, type Universe } from './useUniverse';

export interface TimelineWindow {
  start: number;
  end: number;
}

/**
 * Thin wrapper composing `useUniverse` + `useUpdateUniverse` to expose the
 * per-universe horizontal-timeline `timelineWindow` JSONB column (D-01) as a
 * single read/write API.
 *
 * - `window` resolves to `null` (not `undefined`) when the query is loading or
 *   when the persisted value is `null` — the "first visit, configure range"
 *   cue per D-02 collapses into the same code path.
 * - `setWindow(w)` PATCHes via the existing `useUpdateUniverse` mutation; the
 *   TanStack cache invalidation that hook already wires up (`['universes']` +
 *   `['universe', id]`) is inherited — no new query keys, no new mutations.
 * - `isPending` reflects the underlying mutation state for disabling the
 *   submit button while a write is in flight.
 */
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
