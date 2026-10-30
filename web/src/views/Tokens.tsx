
import { useState } from 'react';
import { useTokens, useRevokeToken, type Token } from '../hooks/useTokens';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CreateTokenDialog } from '../components/CreateTokenDialog';
import { formatRelative } from '../utils/formatRelative';

export default function Tokens() {
  const { data, isPending } = useTokens();
  const revokeToken = useRevokeToken();

  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Token | null>(null);

  const revokeBody = revokeTarget
    ? revokeTarget.label
      ? `Revoking "${revokeTarget.label}" deletes it immediately. Any script or tool using it will start receiving 401 errors on the next request. This can't be undone.`
      : `Revoking this unnamed token deletes it immediately. Any script or tool using it will start receiving 401 errors on the next request. This can't be undone.`
    : '';

  return (
    <div className="max-w-3xl">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Personal access tokens</h1>
        {/* "New token" button rendered here ONLY in the populated state */}
        {data && data.length > 0 && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 rounded-md focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
          >
            New token
          </button>
        )}
      </div>

      {/* Intro paragraph — UI-SPEC §5.1 + §13 verbatim */}
      <p className="mt-2 text-sm text-ink-secondary leading-[1.5]">
        Tokens authenticate API requests as you. Treat them like passwords — anyone with a token can act as your account.
      </p>

      {/* State-specific body */}

      {/* Loading state — 3 skeleton rows (UI-SPEC §5.2) */}
      {isPending && (
        <div className="mt-6 space-y-2" aria-busy="true" aria-label="Loading tokens">
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
            title="No tokens yet"
            body="Create a token to authenticate API requests from scripts or other tools."
            action={
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                New token
              </button>
            }
          />
        </div>
      )}

      {/* Populated state — semantic table (UI-SPEC §5.4) */}
      {!isPending && data && data.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table data-testid="tokens-table" className="w-full text-sm">
            <caption className="sr-only">Your personal access tokens</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-auto">
                  Label
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-48">
                  Preview
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-32">
                  Created
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-32">
                  Last used
                </th>
                <th scope="col" className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-ink-muted w-20">
                  {/* action column — no heading text */}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((token) => (
                <tr key={token.id} className="border-b border-line last:border-0">
                  {/* Label cell — row header for screen reader semantics */}
                  <th scope="row" className="py-3 pr-4 text-left font-normal text-sm leading-[1.5]">
                    {token.label ? (
                      token.label
                    ) : (
                      <span className="italic text-ink-muted">(unnamed)</span>
                    )}
                  </th>

                  {/* Masked preview — UI-SPEC §6.1: 8-char prefix + 6 bullets + 3 suffix chars */}
                  <td className="py-3 pr-4 font-mono text-sm leading-[1.5]">
                    {`wbn_pat_••••••${token.bodySuffix}`}
                  </td>

                  {/* Created date */}
                  <td className="py-3 pr-4 text-sm leading-[1.5]">
                    <time dateTime={token.createdAt} title={new Date(token.createdAt).toLocaleString()}>
                      {formatRelative(token.createdAt)}
                    </time>
                  </td>

                  {/* Last used date — "Never" if null (UI-SPEC §5.6) */}
                  <td className="py-3 pr-4 text-sm leading-[1.5]">
                    {token.lastUsedAt ? (
                      <time dateTime={token.lastUsedAt} title={new Date(token.lastUsedAt).toLocaleString()}>
                        {formatRelative(token.lastUsedAt)}
                      </time>
                    ) : (
                      <span className="text-ink-muted">Never</span>
                    )}
                  </td>

                  {/* Action — Revoke text-button (NOT destructive-red; confirm dialog is) */}
                  <td className="py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setRevokeTarget(token)}
                      className="text-sm text-ink-secondary hover:text-red-600 dark:hover:text-red-500"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create token dialog — single Dialog, two phases (form → reveal) */}
      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} />

      {/* Revoke confirmation — ConfirmDialog with destructive=true */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => { if (!o) setRevokeTarget(null); }}
        title="Revoke token"
        body={revokeBody}
        confirmLabel="Revoke token"
        cancelLabel="Cancel"
        destructive={true}
        onConfirm={async () => {
          if (revokeTarget) {
            try {
              await revokeToken.mutateAsync(revokeTarget.id);
            } catch {
            }
          }
        }}
      />
    </div>
  );
}
