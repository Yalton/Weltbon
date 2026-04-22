import { create } from 'zustand';
import { setAccessToken, clearAccessToken } from '../api/client';

export interface User {
  id: string;
  email: string;
  displayName: string;
}

type Theme = 'dark' | 'light';

interface AuthState {
  user: User | null;
  theme: Theme;
  setSession: (user: User, accessToken: string) => void;
  clearSession: () => void;
  setTheme: (t: Theme) => void;
}

const initialTheme: Theme =
  typeof window !== 'undefined' && localStorage.getItem('weltbon-theme') === 'light'
    ? 'light'
    : 'dark';

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  theme: initialTheme,
  setSession: (user, accessToken) => {
    setAccessToken(accessToken);
    set({ user });
  },
  clearSession: () => {
    clearAccessToken();
    set({ user: null });
  },
  setTheme: (t) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('weltbon-theme', t);
      document.documentElement.classList.toggle('dark', t === 'dark');
    }
    set({ theme: t });
  },
}));
