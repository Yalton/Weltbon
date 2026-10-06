import { create } from 'zustand';
import { setAccessToken, clearAccessToken } from '../api/client';

export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin?: boolean;
}

interface AuthState {
  user: User | null;
  /**
   * True once this page load has established there is no session: a silent
   * refresh failed, or the user signed out. Lets the session check skip a refresh
   * request that would only fail again. Signing in clears it.
   */
  signedOut: boolean;
  markSignedOut: () => void;
  setSession: (user: User, accessToken: string) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  signedOut: false,
  markSignedOut: () => set({ signedOut: true }),
  setSession: (user, accessToken) => {
    setAccessToken(accessToken);
    set({ user, signedOut: false });
  },
  clearSession: () => {
    clearAccessToken();
    set({ user: null, signedOut: true });
  },
}));
