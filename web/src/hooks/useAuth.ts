import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, clearAccessToken } from '../api/client';
import { useAuthStore, type User } from '../store/auth';

interface AuthResponse { accessToken: string; user: User; }

export function useLogin() {
  const setSession = useAuthStore((s) => s.setSession);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      api<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      setSession(data.user, data.accessToken);
      qc.invalidateQueries();
    },
  });
}

export function useRegister() {
  const setSession = useAuthStore((s) => s.setSession);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      email: string;
      password: string;
      displayName: string;
      inviteCode: string;
    }) => api<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      setSession(data.user, data.accessToken);
      qc.invalidateQueries();
    },
  });
}

export function useLogout() {
  const clearSession = useAuthStore((s) => s.clearSession);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      clearAccessToken();
      clearSession();
      qc.clear();
    },
  });
}
