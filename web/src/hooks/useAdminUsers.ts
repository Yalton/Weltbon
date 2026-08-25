import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  isAdmin: boolean;
  disabledAt: string | null;
  disabledReason: string | null;
  impact?: { universesOwned: number; refreshTokensActive: number; patsActive: number };
}

export interface AdminAuditEvent {
  id: string;
  actorEmail: string;
  targetEmail: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export function useAdminUsers() {
  return useQuery({ queryKey: ['admin-users'], queryFn: () => api<AdminUser[]>('/admin/users') });
}

export function getAdminUser(id: string) {
  return api<AdminUser>(`/admin/users/${id}`);
}

export function useAdminAuditLog() {
  return useQuery({ queryKey: ['admin-audit-log'], queryFn: () => api<AdminAuditEvent[]>('/admin/audit-log') });
}

export function useAdminUserActions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, action, reason, confirmEmail, isAdmin }: {
      id: string; action: 'disable' | 'enable' | 'purge' | 'admin'; reason?: string; confirmEmail?: string; isAdmin?: boolean;
    }) => {
      if (action === 'purge') return api(`/admin/users/${id}`, { method: 'DELETE', body: JSON.stringify({ confirmEmail }) });
      if (action === 'admin') return api(`/admin/users/${id}/admin`, { method: 'PATCH', body: JSON.stringify({ isAdmin }) });
      return api(`/admin/users/${id}/${action}`, { method: 'POST', body: action === 'disable' ? JSON.stringify({ reason }) : undefined });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin-audit-log'] }),
  });
}
