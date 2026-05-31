import { useUniverse, useUpdateUniverse, type Universe } from './useUniverse';
import type { Calendar } from '../lib/calendarFormat';

/**
 * Thin wrapper composing `useUniverse` + `useUpdateUniverse` to expose the
 * per-universe fictional `calendar` JSONB column (CALENDAR-01) as a single
 * read/write API.
 *
 * - `calendar` resolves to `null` (not `undefined`) when the query is loading
 *   or when the persisted value is `null` — the "no calendar yet" empty state
 *   per CALENDAR-03 collapses into the same code path.
 * - `setCalendar(c)` PATCHes via the existing `useUpdateUniverse` mutation; the
 *   TanStack cache invalidation that hook already wires up (`['universes']` +
 *   `['universe', id]`) is inherited — no new query keys, no new mutations.
 * - `setCalendar(null)` removes the calendar, reverting timeline positions to
 *   the raw-numeric fallback (CALENDAR-03 / D-13).
 * - `isPending` reflects the underlying mutation state for disabling the
 *   submit button while a write is in flight.
 */
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
