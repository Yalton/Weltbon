
import { useState } from 'react';
import { useInvites, useRevokeInvite, type Invite } from '../hooks/useInvites';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CreateInviteDialog } from '../components/CreateInviteDialog';
import { formatRelative } from '../utils/formatRelative';
import {
  usePendingInviteRequests,
  useIssueInviteRequest,
  useDismissInviteRequest,
  type InviteRequest,
  type IssuedInviteRequest,
} from '../hooks/useInviteRequests';
import { useAuthStore } from '../store/auth';
import { useRuntime } from '../runtime/RuntimeProvider';
import { ApiError } from '../api/client';

function reviewErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return 'This request was already reviewed. The list has been refreshed.';
  }
  if (err instanceof ApiError && err.status === 404) {
    return 'This request no longer exists. The list has been refreshed.';
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function invitationMailto(issued: IssuedInviteRequest): string {
  const subject = 'Your Weltbon invitation code';
  const body =
    `Hi ${issued.request.name},\n\n` +
    `Here is your Weltbon invitation code. It can be used once, to create your account:\n\n` +
    `${issued.invite.plaintext}\n`;
  return `mailto:${issued.request.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Admin review of public invite requests. Renders nothing unless the viewer is an
 * admin on a server-mode instance (local mode has no accounts to invite into).
 */
function InviteRequestsSection() {
  const isAdmin = useAuthStore((s) => s.user?.isAdmin === true);
  const { authMode } = useRuntime();
  const visible = isAdmin && authMode === 'server';

  const { data, isPending, error: loadError } = usePendingInviteRequests(visible);
  const issueRequest = useIssueInviteRequest();
  const dismissRequest = useDismissInviteRequest();

  const [issued, setIssued] = useState<IssuedInviteRequest | null>(null);
  const [dismissTarget, setDismissTarget] = useState<InviteRequest | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  if (!visible) return null;

  const handleIssue = async (request: InviteRequest) => {
    setActionError(null);
    setCopied(false);
    setCopyError(false);
    try {
      setIssued(await issueRequest.mutateAsync(request.id));
    } catch (err) {
      setActionError(reviewErrorMessage(err));
    }
  };

  const handleCopy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.invite.plaintext);
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <section className="mt-6" aria-labelledby="invite-requests-heading">
      <h2 id="invite-requests-heading" className="text-lg font-semibold">Requests</h2>

      {/* One-time reveal of a just-issued code — mirrors CreateInviteDialog's reveal phase */}
      {issued && (
        <div className="mt-3 rounded-md border border-line p-4">
          <p className="text-sm text-ink-secondary leading-[1.5]">
            Code issued for {issued.request.name}. This is the only time you&apos;ll see it — copy it or email it now.
          </p>
          <div className="mt-3 rounded-md border border-line bg-raised p-3">
            <code
              className="font-mono text-sm leading-[1.5] break-all select-all text-ink"
              aria-label="Issued invite code"
            >{issued.invite.plaintext}</code>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              {copied ? 'Copied!' : 'Copy invite code'}
            </button>
            <a
              href={invitationMailto(issued)}
              className="px-3 py-1.5 text-sm rounded-md border border-line-strong"
            >
              Email {issued.request.email}
            </a>
            <button
              type="button"
              onClick={() => setIssued(null)}
              className="ml-auto px-3 py-1.5 text-sm rounded-md border border-line-strong"
            >
              Done
            </button>
          </div>
          {copyError && (
            <p className="mt-2 text-sm text-red-500" role="alert">
              Couldn&apos;t copy. Select the code above and copy manually.
            </p>
          )}
          <span aria-live="polite" className="sr-only">
            {copied ? 'Invite code copied to clipboard' : ''}
          </span>
        </div>
      )}

      {actionError && (
        <p className="mt-3 text-sm text-red-500" role="alert">{actionError}</p>
      )}

      {isPending && (
        <div className="mt-3 h-12 rounded-md bg-raised animate-pulse" aria-busy="true" aria-label="Loading invite requests" />
      )}

      {loadError && (
        <p className="mt-3 text-sm text-red-500" role="alert">
          Couldn&apos;t load invite requests: {(loadError as Error).message}
        </p>
      )}

      {!isPending && data && data.length === 0 && (
        <p className="mt-3 text-sm text-ink-muted">No pending requests</p>
      )}

      {!isPending && data && data.length > 0 && (
        <ul data-testid="invite-requests-list" className="mt-3 divide-y divide-[color:var(--color-line)]">
          {data.map((request) => (
            <li key={request.id} className="py-3 flex items-start gap-4">
              <div className="min-w-0 flex-1 text-sm leading-[1.5]">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{request.name}</span>
                  <span className="text-ink-secondary break-all">{request.email}</span>
                  <time
                    dateTime={request.createdAt}
                    title={new Date(request.createdAt).toLocaleString()}
                    className="text-xs text-ink-muted"
                  >
                    {formatRelative(request.createdAt)}
                  </time>
                </div>
                {request.note && (
                  <p className="mt-1 text-ink-secondary whitespace-pre-wrap break-words">{request.note}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleIssue(request)}
                  disabled={issueRequest.isPending}
                  className="text-sm text-[color:var(--color-accent)] hover:opacity-80 disabled:opacity-50"
                >
                  Issue code
                </button>
                <button
                  type="button"
                  onClick={() => { setActionError(null); setDismissTarget(request); }}
                  className="text-sm text-ink-secondary hover:text-red-600 dark:hover:text-red-500"
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!dismissTarget}
        onOpenChange={(o) => { if (!o) setDismissTarget(null); }}
        title="Dismiss invite request"
        body={dismissTarget ? `Dismiss the request from ${dismissTarget.name} (${dismissTarget.email})? No code will be issued, and the request leaves this list.` : ''}
        confirmLabel="Dismiss request"
        cancelLabel="Cancel"
        destructive={true}
        onConfirm={async () => {
          if (dismissTarget) {
            try {
              await dismissRequest.mutateAsync(dismissTarget.id);
            } catch (err) {
              setActionError(reviewErrorMessage(err));
            }
          }
        }}
      />
    </section>
  );
}

export default function Invites() {
  const { data, isPending } = useInvites();
  const revokeInvite = useRevokeInvite();

  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Invite | null>(null);

  const revokeBody = revokeTarget
    ? revokeTarget.label
      ? `Revoking "${revokeTarget.label}" makes it immediately invalid. Anyone who tries to register with this code will see the standard invalid-code error. This can't be undone.`
      : `Revoking this unnamed invite code makes it immediately invalid. Anyone who tries to register with this code will see the standard invalid-code error. This can't be undone.`
    : '';

  return (
    <div className="max-w-3xl">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Invite codes</h1>
        {/* "New invite code" button rendered here ONLY in the populated state */}
        {data && data.length > 0 && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 rounded-md focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
          >
            New invite code
          </button>
        )}
      </div>

      {/* Intro paragraph — UI-SPEC §5.1 + §13 verbatim */}
      <p className="mt-2 text-sm text-ink-secondary leading-[1.5]">
        Invite codes let you onboard new users. Each code is single-use — share it once, and it expires on registration. Treat codes like passwords and never share a code you've already sent.
      </p>

      <InviteRequestsSection />

      {/* State-specific body */}

      {/* Loading state — 3 skeleton rows (UI-SPEC §5.2) */}
      {isPending && (
        <div className="mt-6 space-y-2" aria-busy="true" aria-label="Loading invite codes">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-md bg-raised animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state (UI-SPEC §5.3) */}
      {!isPending && data && data.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No invite codes yet"
            body="Create an invite code to share with someone you want to onboard. Each code can only be used once."
            action={
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                New invite code
              </button>
            }
          />
        </div>
      )}

      {/* Populated state — semantic table (UI-SPEC §5.4) */}
      {!isPending && data && data.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table data-testid="invites-table" className="w-full text-sm">
            <caption className="sr-only">Your invite codes</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-auto">
                  Label
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-52">
                  Preview
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-32">
                  Created
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-24">
                  Status
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-40">
                  Used by
                </th>
                <th scope="col" className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-ink-muted w-20">
                  {/* action column — no heading text */}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((invite) => {
                // Derive status inline per UI-SPEC §7.1
                const status: 'active' | 'used' | 'revoked' =
                  invite.revokedAt ? 'revoked' : invite.usedAt ? 'used' : 'active';

                return (
                  <tr
                    key={invite.id}
                    className={[
                      'border-b border-line last:border-0',
                      status === 'revoked' ? 'opacity-50' : '',
                    ].join(' ')}
                  >
                    {/* Label cell — row header for screen reader semantics */}
                    <th
                      scope="row"
                      className={`py-3 pr-4 text-left font-normal text-sm leading-[1.5]${status === 'revoked' ? ' line-through' : ''}`}
                    >
                      {invite.label ? (
                        invite.label
                      ) : (
                        <span className="text-ink-muted italic">(unnamed)</span>
                      )}
                    </th>

                    {/* Masked preview — UI-SPEC §6.1 (mirrors PAT masked-preview pattern) */}
                    <td className="py-3 pr-4 font-mono text-sm leading-[1.5]">
                      {`wbn_inv_••••••${invite.bodySuffix}`}
                    </td>

                    {/* Created date */}
                    <td className="py-3 pr-4 text-sm leading-[1.5]">
                      <time
                        dateTime={invite.createdAt}
                        title={new Date(invite.createdAt).toLocaleString()}
                      >
                        {formatRelative(invite.createdAt)}
                      </time>
                    </td>

                    {/* Status chip — three STATIC JSX branches (no dynamic class concat) */}
                    <td className="py-3 pr-4">
                      {status === 'active' && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">active</span>
                      )}
                      {status === 'used' && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-raised text-ink-muted">used</span>
                      )}
                      {status === 'revoked' && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400">revoked</span>
                      )}
                    </td>

                    {/* Used by cell — only renders when status === 'used' AND usedBy present (UI-SPEC §5.7) */}
                    <td className="py-3 pr-4 text-sm">
                      {invite.usedBy && status === 'used'
                        ? invite.usedBy.displayName
                          ? (
                            <span
                              title={invite.usedBy.email}
                              className="truncate max-w-[10rem] block leading-[1.5]"
                            >
                              {invite.usedBy.displayName}
                            </span>
                          )
                          : (
                            <span className="italic text-ink-secondary truncate max-w-[10rem] block leading-[1.5]">
                              {invite.usedBy.email}
                            </span>
                          )
                        : null}
                    </td>

                    {/* Action — Revoke text-button only on active rows */}
                    <td className="py-3 text-right">
                      {status === 'active' && (
                        <button
                          type="button"
                          onClick={() => setRevokeTarget(invite)}
                          className="text-sm text-ink-secondary hover:text-red-600 dark:hover:text-red-500"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}


      <CreateInviteDialog open={createOpen} onOpenChange={setCreateOpen} />

      {/* Revoke confirmation — ConfirmDialog with destructive=true */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => { if (!o) setRevokeTarget(null); }}
        title="Revoke invite code"
        body={revokeBody}
        confirmLabel="Revoke code"
        cancelLabel="Cancel"
        destructive={true}
        onConfirm={async () => {
          if (revokeTarget) {
            try {
              await revokeInvite.mutateAsync(revokeTarget.id);
            } catch {
            }
          }
        }}
      />
    </div>
  );
}
