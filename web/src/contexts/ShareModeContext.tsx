import { createContext, useContext, type ReactNode } from 'react';
import type { Calendar } from '../lib/calendarFormat';
import type { TimelineWindow } from '../hooks/useTimelineWindow';

/**
 * Phase 29 share-mode context — widened in Phase 33 from a boolean to an
 * object so the share subtree can also carry `calendar` and `token`.
 *
 * Default value (`{ isShareMode: false, calendar: null, token: null }`) is
 * the safe authenticated-path fallback: any view rendered OUTSIDE a
 * `<ShareModeProvider>` behaves identically to before (T-29-27
 * leak-prevention invariant at the context layer).
 *
 * The `useShareMode()` hook returns a boolean for all existing callers
 * (EntryDetail, TimelineView, EntryList, GraphView) so NONE of those files
 * need to change their hook call — full source-compatibility preserved.
 *
 * New selector hooks added for the extra data:
 *   `useShareCalendar()` — returns the universe calendar from share meta, or null
 *   `useShareToken()`    — returns the share token string, or null
 */

interface ShareModeContextValue {
  isShareMode: boolean;
  calendar: Calendar | null;
  token: string | null;
  timelineWindow: TimelineWindow | null;
}

const DEFAULT_VALUE: ShareModeContextValue = {
  isShareMode: false,
  calendar: null,
  token: null,
  timelineWindow: null,
};

export const ShareModeContext = createContext<ShareModeContextValue>(DEFAULT_VALUE);

interface ShareModeProviderProps {
  children: ReactNode;
  /** Calendar from `GET /api/share/universe`; null if the universe has none. */
  calendar?: Calendar | null;
  /** The share token extracted from the route param. */
  token?: string | null;
  /** timelineWindow from `GET /api/share/universe`; null if unconfigured. */
  timelineWindow?: TimelineWindow | null;
}

/**
 * Wraps the `/share/:token` subtree so descendant views read the share-mode
 * value from `ShareModeContext`. Mounted exclusively by `ShareLayout`.
 *
 * `calendar` and `token` default to `null` — callers that don't pass them
 * still get `isShareMode: true`, matching the pre-Phase-33 behaviour.
 */
export function ShareModeProvider({
  children,
  calendar = null,
  token = null,
  timelineWindow = null,
}: ShareModeProviderProps) {
  return (
    <ShareModeContext.Provider
      value={{ isShareMode: true, calendar, token, timelineWindow }}
    >
      {children}
    </ShareModeContext.Provider>
  );
}

/**
 * Hook for views to discover whether they are rendering inside a share
 * subtree. Returns `false` outside any provider (the safe default).
 *
 * Existing callers are source-compatible: the return type is still `boolean`.
 */
export function useShareMode(): boolean {
  return useContext(ShareModeContext).isShareMode;
}

/**
 * Hook for share-subtree views to access the universe calendar supplied via
 * the share meta endpoint. Returns `null` outside a provider or when the
 * universe has no calendar defined.
 *
 * Closes INT-BLOCKER-1: `TimelineView` and `EntryDetail` call this to
 * override the `useCalendar('share')` null they get from `useUniverse('share')`.
 */
export function useShareCalendar(): Calendar | null {
  return useContext(ShareModeContext).calendar;
}

/**
 * Hook for share-subtree views to access the share token so they can build
 * correct navigation targets (e.g. wikilink entry links, "View on timeline").
 * Returns `null` outside a provider.
 */
export function useShareToken(): string | null {
  return useContext(ShareModeContext).token;
}

/**
 * Hook for the share TimelineView to access the universe's configured
 * timelineWindow, supplied via the share meta endpoint. Returns `null` outside
 * a provider or when the owner has not configured a range. Without this the
 * share timeline 404s on `useTimelineWindow('share')` and renders empty.
 */
export function useShareTimelineWindow(): TimelineWindow | null {
  return useContext(ShareModeContext).timelineWindow;
}
