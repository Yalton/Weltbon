import { create } from 'zustand';
import { setAccessToken, clearAccessToken } from '../api/client';

export interface User {
  id: string;
  email: string;
  displayName: string;
}

interface AuthState {
  user: User | null;
  setSession: (user: User, accessToken: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  setSession: (user, accessToken) => {
    setAccessToken(accessToken);
    set({ user });
  },
  clearSession: () => {
    clearAccessToken();
    set({ user: null });
  },
}));
