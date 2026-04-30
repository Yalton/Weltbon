/**
 * simSettings Zustand store — POL-03 toggle for entries-as-bodies layer.
 *
 * Per UI-SPEC §7.2 + D-09:
 * - Single boolean showEntriesAsBodies; default OFF.
 * - Mirrored to localStorage['weltbon-show-entries-as-bodies']:
 *     '1' → true, '0' → false (anything else including null → false).
 * - Falls back gracefully when localStorage is unavailable (SSR / private mode).
 */

import { create } from 'zustand';

const LS_KEY = 'weltbon-show-entries-as-bodies';

/**
 * Read initial value from localStorage.
 * Returns false (default OFF) if:
 * - localStorage is unavailable
 * - value is anything other than '1'
 */
function readFromStorage(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Write value to localStorage.
 * No-ops silently if localStorage is unavailable.
 */
function writeToStorage(value: boolean): void {
  try {
    localStorage.setItem(LS_KEY, value ? '1' : '0');
  } catch {
    // Private mode / SSR — cosmetic setting; failure is acceptable.
  }
}

export interface SimSettingsStore {
  showEntriesAsBodies: boolean;
  setShowEntriesAsBodies: (v: boolean) => void;
}

export const useSimSettings = create<SimSettingsStore>((set) => ({
  showEntriesAsBodies: readFromStorage(),
  setShowEntriesAsBodies: (v: boolean) => {
    writeToStorage(v);
    set({ showEntriesAsBodies: v });
  },
}));
