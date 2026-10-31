/**
 *
 * Mounted on AdminUsers.tsx (Administration page). This is the OTHER side of
 * component's whole design is "reveal nothing about the owner", this one's
 * whole design is the opposite — an administrator legitimately needs to see
 * WHO a grant is between (owner and recipient identity) to manage it, and
 * `AdminSharedGrant` (useLlmShares.ts) is typed to carry exactly that.
 *
 * What must still never render, even here: key material. An administrator
 * managing shared access has no legitimate reason to see the ciphertext,
 * plaintext, bodySuffix, or key id of ANY key — their own or anyone else's —
 * through this screen; that is what Settings → LLM keys is for. The
 * component only has fields to render from `AdminSharedGrant`, which
 * carries none of that, but the test suite still asserts it the same way
 * SharedLlmConnections.test.tsx does: a poisoned fixture and a full-DOM scan.
 *
 * The create call sends EXACTLY `{ recipientUserId, provider }` — see
 * useLlmShares.ts's `useCreateAdminSharedLlmGrant`, whose mutation variables
 * ARE the body with no merge step in between. The server's `createBody`
 * schema is `.strict()`, so a third field would 400 rather than silently
 * pass through — this component still keeps the invariant visible in one
 * place instead of relying only on that server-side backstop.
 */

import { useState } from 'react';
import { useAdminUsers } from '../hooks/useAdminUsers';
import {
  useAdminSharedLlmGrants,
  useCreateAdminSharedLlmGrant,
  useRevokeAdminSharedLlmGrant,
  type AdminSharedGrant,
  type SharedProvider,
} from '../hooks/useLlmShares';
import { ConfirmDialog } from './ConfirmDialog';
import { ApiError } from '../api/client';

function statusMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : 'Could not reach the server. Try again in a moment.';
}

// Shared access is anthropic/openai only — Ollama is local/desktop-only and
const PROVIDERS: { value: SharedProvider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
];

export function AdminSharedLlmConnections() {
  const { data: usersRaw } = useAdminUsers();
  const users = Array.isArray(usersRaw) ? usersRaw : [];
  const activeUsers = users.filter((u) => u.disabledAt === null);

  const { data: grantsRaw, isPending, error } = useAdminSharedLlmGrants();
  const grants: AdminSharedGrant[] = Array.isArray(grantsRaw) ? grantsRaw : [];
  const create = useCreateAdminSharedLlmGrant();
  const revoke = useRevokeAdminSharedLlmGrant();

  const [recipientUserId, setRecipientUserId] = useState('');
  const [provider, setProvider] = useState<SharedProvider>('anthropic');
  const [outcome, setOutcome] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<AdminSharedGrant | null>(null);

  const handleGrant = () => {
    if (!recipientUserId) return;
    setOutcome('');
    create.mutate(
      { recipientUserId, provider },
      { onSuccess: () => setOutcome('Shared connection granted.') },
    );
  };

  return (
    <section
      aria-labelledby="admin-shared-llm-heading"
      data-testid="admin-shared-llm-connections"
      className="mt-8"
    >
      <h2 id="admin-shared-llm-heading" className="text-lg font-semibold tracking-tight">
        Shared LLM connections
      </h2>
      <p className="mt-1 text-sm text-ink-secondary">
        Grant a user access to your hosted Anthropic or OpenAI credential,
        under a monthly spend cap. The recipient must accept a disclosure
        before any audit can run on it.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs mb-1" htmlFor="admin-shared-recipient">
            User
          </label>
          <select
            id="admin-shared-recipient"
            value={recipientUserId}
            onChange={(e) => setRecipientUserId(e.target.value)}
            className="rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
          >
            <option value="">Select a user</option>
            {activeUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} ({u.email})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs mb-1" htmlFor="admin-shared-provider">
            Provider
          </label>
          <select
            id="admin-shared-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as SharedProvider)}
            className="rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={handleGrant}
          disabled={create.isPending || !recipientUserId}
          className="btn-accent text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2 disabled:opacity-50"
        >
          {create.isPending ? 'Granting…' : 'Grant'}
        </button>
      </div>

      <p aria-live="polite" className="mt-2 text-xs text-ink-secondary empty:mt-0">
        {create.isPending ? 'Granting…' : outcome}
      </p>
      {create.error && (
        <p className="mt-1 text-sm text-red-500" role="alert">
          {statusMessage(create.error)}
        </p>
      )}

      {revoke.error && (
        <p className="mt-1 text-sm text-red-500" role="alert">
          {statusMessage(revoke.error)}
        </p>
      )}

      {isPending ? (
        <p className="mt-4 text-sm text-ink-secondary">Loading…</p>
      ) : error ? (
        <p className="mt-4 text-sm text-red-500" role="alert">
          Could not load shared connections. Reload the page to try again.
        </p>
      ) : grants.length === 0 ? (
        <p className="mt-4 text-sm text-ink-secondary">
          No shared connections yet.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Administrator-granted shared LLM connections</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide font-medium text-ink-muted">
                <th scope="col" className="pb-2 pr-4">Owner</th>
                <th scope="col" className="pb-2 pr-4">Recipient</th>
                <th scope="col" className="pb-2 pr-4">Provider</th>
                <th scope="col" className="pb-2 pr-4">Status</th>
                <th scope="col" className="pb-2 pr-4">Consent</th>
                <th scope="col" className="pb-2 pr-4">Usage</th>
                <th scope="col" className="pb-2 pr-4">Failures</th>
                <th scope="col" className="pb-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr
                  key={grant.id}
                  data-testid={`admin-shared-llm-grant-${grant.id}`}
                  className="border-b border-line last:border-0"
                >
                  <td className="py-2 pr-4">
                    {grant.owner.displayName}
                    <div className="text-xs text-ink-secondary">{grant.owner.email}</div>
                  </td>
                  <td className="py-2 pr-4">
                    {grant.recipient.displayName}
                    <div className="text-xs text-ink-secondary">{grant.recipient.email}</div>
                  </td>
                  <td className="py-2 pr-4">{grant.provider}</td>
                  <td className="py-2 pr-4">{grant.status}</td>
                  <td className="py-2 pr-4">{grant.consentedAt !== null ? 'Consented' : 'Not yet consented'}</td>
                  <td className="py-2 pr-4">
                    ${grant.usage.settledUsd} / ${grant.usage.limitUsd}
                  </td>
                  <td className="py-2 pr-4">{grant.usage.failedAudits} failed</td>
                  <td className="py-2">
                    {grant.status === 'active' && (
                      <button
                        type="button"
                        onClick={() => setRevokeTarget(grant)}
                        disabled={revoke.isPending}
                        className="text-sm px-3 py-1.5 rounded-md border border-line-strong hover:bg-white/5 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={
          revokeTarget
            ? `Revoke ${revokeTarget.provider} access for ${revokeTarget.recipient.displayName}?`
            : 'Revoke shared connection?'
        }
        body="The recipient immediately loses the ability to run audits on this connection. Takes effect at the next audit checkpoint: a run already in flight stops rather than finishes."
        confirmLabel="Revoke"
        cancelLabel="Keep it"
        destructive
        onConfirm={() => {
          if (!revokeTarget) return;
          const target = revokeTarget;
          setRevokeTarget(null);
          setOutcome('');
          revoke.mutate(
            { grantId: target.id },
            { onSuccess: () => setOutcome('Shared connection revoked.') },
          );
        }}
      />
    </section>
  );
}
