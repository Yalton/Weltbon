
import { create } from 'zustand';

const LS_KEY = 'weltbon-show-entries-as-bodies';

function readFromStorage(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeToStorage(value: boolean): void {
  try {
    localStorage.setItem(LS_KEY, value ? '1' : '0');
  } catch {
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
