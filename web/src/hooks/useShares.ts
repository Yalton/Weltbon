
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface ShareLink {
  id: string;
  universeId: string;
  universeName: string;
  label: string;
  bodySuffix: string;
  scope: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
}

export interface ShareLinkWithUrl {
  id: string;
  label: string;
  bodySuffix: string;
  expiresAt: string | null;
  createdAt: string;
  shareUrl: string;
}

export type ShareExpiryDays = 7 | 30 | 90 | 180 | 365 | null;

export function useShares() {
  return useQuery({
    queryKey: ['shares'],
    queryFn: () =>
      api<{ shares: ShareLink[] }>('/shares').then((r) => r.shares),
  });
}

export function useCreateShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      universeId: string;
      label: string;
      expiresInDays: ShareExpiryDays;
    }) =>
      api<ShareLinkWithUrl>('/shares', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares'] });
    },
  });
}

export function useRenameShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      api<{ id: string; label: string }>(`/shares/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares'] });
    },
  });
}

export function useRevokeShareLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/shares/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares'] });
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: ['shares'] });
    },
  });
}
