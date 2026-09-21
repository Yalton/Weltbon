import { createContext, useContext, type ReactNode } from 'react';
import type { Calendar } from '../lib/calendarFormat';
import type { TimelineWindow } from '../hooks/useTimelineWindow';

/**
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
  calendar?: Calendar | null;
  token?: string | null;
  timelineWindow?: TimelineWindow | null;
}

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

export function useShareMode(): boolean {
  return useContext(ShareModeContext).isShareMode;
}

export function useShareCalendar(): Calendar | null {
  return useContext(ShareModeContext).calendar;
}

export function useShareToken(): string | null {
  return useContext(ShareModeContext).token;
}

export function useShareTimelineWindow(): TimelineWindow | null {
  return useContext(ShareModeContext).timelineWindow;
}
