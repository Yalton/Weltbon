import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { InviteWithPlaintext } from './useInvites';

/** A row from GET /api/admin/invite-requests. */
export interface InviteRequest {
  id: string;
  name: string;
  email: string;
  note: string | null;
  status: 'pending' | 'issued' | 'dismissed';
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: { email: string; displayName: string } | null;
  inviteCodeId: string | null;
}

export interface IssuedInviteRequest {
  request: InviteRequest;
  invite: InviteWithPlaintext;
}

const PENDING_KEY = ['invite-requests', 'pending'] as const;

/** Pending invite requests, newest first. Admin-only; pass `enabled: false` otherwise. */
export function usePendingInviteRequests(enabled: boolean) {
  return useQuery({
    queryKey: PENDING_KEY,
    queryFn: () => api<InviteRequest[]>('/admin/invite-requests?status=pending'),
    enabled,
  });
}

function useReviewMutation<T>(action: 'issue' | 'dismiss') {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['invite-requests'] });
    qc.invalidateQueries({ queryKey: ['invites'] });
  };
  return useMutation({
    mutationFn: (id: string) =>
      api<T>(`/admin/invite-requests/${id}/${action}`, { method: 'POST' }),
    // A 409 (already reviewed elsewhere) also means our list is stale.
    onSettled: refresh,
  });
}

export function useIssueInviteRequest() {
  return useReviewMutation<IssuedInviteRequest>('issue');
}

export function useDismissInviteRequest() {
  return useReviewMutation<InviteRequest>('dismiss');
}
