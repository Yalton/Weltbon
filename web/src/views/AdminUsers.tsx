import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { getAdminUser, useAdminAuditLog, useAdminUserActions, useAdminUsers, type AdminUser } from '../hooks/useAdminUsers';
import { useAuthStore } from '../store/auth';
// #50 Task 9 — administrator-side grant/revoke panel for shared LLM access.
import { AdminSharedLlmConnections } from '../components/AdminSharedLlmConnections';

export default function AdminUsers() {
  const isAdmin = useAuthStore((state) => state.user?.isAdmin === true);
  const { data: users = [], isPending } = useAdminUsers();
  const { data: audit = [] } = useAdminAuditLog();
  const action = useAdminUserActions();
  const [reason, setReason] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<AdminUser | null>(null);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [impact, setImpact] = useState<AdminUser['impact']>();

  if (!isAdmin) return <Navigate to="/settings" replace />;
  const submitPurge = async (event: FormEvent) => {
    event.preventDefault();
    if (!confirming) return;
    await action.mutateAsync({ id: confirming.id, action: 'purge', confirmEmail });
    setConfirming(null);
    setConfirmEmail('');
  };

  return <section className="space-y-8">
    <div><h1 className="text-2xl font-semibold tracking-tight">Administration</h1><p className="mt-2 text-sm text-ink-secondary">Manage production accounts and review operator actions.</p></div>
    {isPending ? <p>Loading users…</p> : <div className="overflow-x-auto rounded border border-neutral-200 dark:border-neutral-800"><table className="w-full text-sm"><thead><tr className="text-left"><th className="p-3">User</th><th className="p-3">Role</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead><tbody>{users.map((user) => <tr key={user.id} className="border-t border-neutral-200 dark:border-neutral-800"><td className="p-3"><div>{user.displayName}</div><div className="text-ink-secondary">{user.email}</div></td><td className="p-3">{user.isAdmin ? 'Administrator' : 'Member'}</td><td className="p-3">{user.disabledAt ? `Disabled${user.disabledReason ? `: ${user.disabledReason}` : ''}` : 'Active'}</td><td className="p-3"><div className="flex flex-wrap gap-2"><button onClick={() => action.mutate({ id: user.id, action: 'admin', isAdmin: !user.isAdmin })}>{user.isAdmin ? 'Remove admin' : 'Make admin'}</button>{user.disabledAt ? <button onClick={() => action.mutate({ id: user.id, action: 'enable' })}>Enable</button> : <><button onClick={() => action.mutate({ id: user.id, action: 'disable', reason: reason[user.id] })}>Disable</button><input aria-label={`Disable reason for ${user.email}`} value={reason[user.id] ?? ''} onChange={(e) => setReason({ ...reason, [user.id]: e.target.value })} placeholder="Reason (optional)" /></>}<button onClick={async () => { setConfirming(user); setImpact((await getAdminUser(user.id)).impact); }}>Purge</button></div></td></tr>)}</tbody></table></div>}
    <section><h2 className="text-lg font-semibold">Recent operator activity</h2><ul className="mt-3 space-y-2 text-sm">{audit.map((event) => <li key={event.id}><span className="font-medium">{event.actorEmail}</span> {event.action} <span className="font-medium">{event.targetEmail}</span> <span className="text-ink-secondary">{new Date(event.createdAt).toLocaleString()}</span></li>)}</ul></section>
    <AdminSharedLlmConnections />
    {confirming && <form onSubmit={submitPurge} className="rounded border border-red-400 p-4 space-y-3"><h2 className="font-semibold">Purge {confirming.email}?</h2><p className="text-sm">This permanently deletes the account and its owned data. {impact && `${impact.universesOwned} universe(s), ${impact.refreshTokensActive} active session(s), and ${impact.patsActive} active API token(s) will be removed.`} Type the email address to confirm.</p><input aria-label="Confirmation email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} /><div className="flex gap-2"><button type="submit" disabled={action.isPending || confirmEmail !== confirming.email}>Permanently purge</button><button type="button" onClick={() => { setConfirming(null); setImpact(undefined); }}>Cancel</button></div></form>}
  </section>;
}
