import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * An invite-code row as returned by GET /api/auth/invites.
 *
 * The hash and plaintext are never included in list responses (server-side whitelist —
 * portion, surfaced only so the UI can render a masked preview ("wbn_inv_••••••XYZ").
 *
 * `usedBy` is server-resolved via JOIN on `consumed_by_user_id`; the UI treats it as
 * opaque display data and never makes trust decisions on it (T-13-04-02).
 */
export interface Invite {
  id: string;
  label: string;
  bodySuffix: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  usedBy: { displayName: string; email: string } | null;
}

/**
 * The full response from POST /api/auth/invites.
 *
 * `plaintext` is shown exactly once in the one-time-reveal modal (mirrors PAT pattern,
 * UI-SPEC §6.2 / D-INV-05); it is not stored after the modal closes.
 */
export interface InviteWithPlaintext {
  id: string;
  label: string;
  bodySuffix: string;
  createdAt: string;
  plaintext: string;
}

export function useInvites() {
  return useQuery({
    queryKey: ['invites'],
    queryFn: () => api<Invite[]>('/auth/invites'),
  });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label }: { label: string }) =>
      api<InviteWithPlaintext>('/auth/invites', {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invites'] });
    },
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/auth/invites/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: ['invites'] });
    },
  });
}
