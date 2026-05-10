/**
 * Invites view — /settings/invites
 *
 * Invite-code self-service page (INV-02).
 * Three states: loading (skeleton rows), empty state, populated table.
 * Per UI-SPEC §5, copywriting locked to §13. Mirrors Tokens.tsx structure
 * with the six-column shape (Label | Preview | Created | Status | Used by | Action).
 *
 * Status is derived inline from the timestamp pair (revokedAt/usedAt) per UI-SPEC §7.1.
 * Status chip uses three SEPARATE static JSX branches (Phase 2 class-string lock —
 * no dynamic class concatenation that would defeat Tailwind JIT, see T-13-04-03).
 *
 * Route: /settings/invites (nested inside SettingsLayout — wired by plan 13-06).
 */

import { useState } from 'react';
import { useInvites, useRevokeInvite, type Invite } from '../hooks/useInvites';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CreateInviteDialog } from '../components/CreateInviteDialog';
import { formatRelative } from '../utils/formatRelative';

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
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
        Invite codes let you onboard new users. Each code is single-use — share it once, and it expires on registration. Treat codes like passwords and never share a code you've already sent.
      </p>

      {/* State-specific body */}

      {/* Loading state — 3 skeleton rows (UI-SPEC §5.2) */}
      {isPending && (
        <div className="mt-6 space-y-2" aria-busy="true" aria-label="Loading invite codes">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-md bg-neutral-100 dark:bg-neutral-800 animate-pulse"
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
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-auto">
                  Label
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-52">
                  Preview
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32">
                  Created
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-24">
                  Status
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-40">
                  Used by
                </th>
                <th scope="col" className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500 w-20">
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
                      'border-b border-neutral-100 dark:border-neutral-800 last:border-0',
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
                        <span className="text-neutral-500 italic">(unnamed)</span>
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
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-500">used</span>
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
                            <span className="italic text-neutral-600 dark:text-neutral-400 truncate max-w-[10rem] block leading-[1.5]">
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
                          className="text-sm text-neutral-600 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-500"
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

      {/* Create invite dialog — single Dialog, two phases (form → reveal) — built by plan 13-05 */}
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
              // Silent invalidate on 404 race — useRevokeInvite's onError handles it.
            }
          }
        }}
      />
    </div>
  );
}
