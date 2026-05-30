/**
 * ShareLinksSection — Phase 29 per-universe Share Links section
 * embedded on UniverseSettings → Share Links tab (UI-SPEC §D).
 *
 * Owner workflow:
 *   1. See the list of ACTIVE share links for this universe (revoked rows
 *      are filtered client-side here; the global /settings/shares view
 *      surfaces the full audit trail including revoked tokens).
 *   2. Click "Create share link" → opens CreateShareLinkDialog (two-phase
 *      form → reveal). The plaintext URL is shown exactly once.
 *   3. Click "Revoke" on a row → opens ConfirmDialog (destructive=true)
 *      → on confirm, DELETE /api/shares/:id → react-query invalidates
 *      `['shares']` and the row disappears.
 *
 * Per UI-SPEC §D the per-token row deliberately OMITS:
 *   - the Status column (filtered to active rows; the global view has it)
 *   - the Copy action (plaintext is gone after creation — D-08 one-time
 *     reveal is irreversible)
 *   - the inline rename UX (rename lives on /settings/shares per §F)
 */

import { useMemo, useState } from 'react';
import {
  useShares,
  useRevokeShareLink,
  type ShareLink,
} from '../hooks/useShares';
import { CreateShareLinkDialog } from './CreateShareLinkDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { formatRelative } from '../utils/formatRelative';

interface Props {
  universeId: string;
}

export function ShareLinksSection({ universeId }: Props) {
  const { data: allShares, isPending } = useShares();
  const revokeShareLink = useRevokeShareLink();

  // UI-SPEC §D: filter to non-revoked rows. Revoked tokens disappear from
  // the UniverseSettings list immediately; the full audit trail lives on
  // /settings/shares (UI-SPEC §F).
  const universeShares = useMemo(
    () =>
      (allShares ?? []).filter(
        (s) => s.universeId === universeId && !s.revokedAt
      ),
    [allShares, universeId]
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ShareLink | null>(null);

  // UI-SPEC §Copywriting Contract §Destructive Confirmations verbatim.
  const revokeBody = revokeTarget
    ? revokeTarget.label
      ? `Revoking "${revokeTarget.label}" makes it immediately invalid. Anyone with the link will see a "not found" page. This can't be undone.`
      : `Revoking this share link makes it immediately invalid. Anyone with the link will see a "not found" page. This can't be undone.`
    : '';

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Share Links</h2>
        {/* UI-SPEC §D: Create button rendered in the same row as the h2
            ONLY in the populated state — empty state owns its own CTA
            inside the EmptyState below. */}
        {!isPending && universeShares.length > 0 && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 rounded-md focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
          >
            Create share link
          </button>
        )}
      </div>

      {/* UI-SPEC §Copywriting Contract §Descriptive Copy verbatim. */}
      <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5] mb-4">
        Share links let visitors browse this universe without signing in. You control which entries are visible using the Public toggle on each entry.
      </p>

      {/* Loading skeleton (3 rows) — mirrors Invites.tsx pattern. */}
      {isPending && (
        <div
          className="mt-6 space-y-2"
          aria-busy="true"
          aria-label="Loading share links"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-md bg-neutral-100 dark:bg-neutral-800 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state — UI-SPEC §D: py-12 wrapper override on EmptyState
          because this is a settings sub-section, not a full-page empty. */}
      {!isPending && universeShares.length === 0 && (
        <div className="py-12">
          <EmptyState
            title="No share links yet"
            body="Create a link to let someone view this universe without signing in."
            action={
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                Create share link
              </button>
            }
          />
        </div>
      )}

      {/* Populated state — semantic table.
          UI-SPEC §D columns: Label | Preview | Created | Expiry | Last
          accessed | Access count | Actions. NO Status column, NO Copy
          action (per UI-SPEC §D — the global view owns those). */}
      {!isPending && universeShares.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Share links for this universe
            </caption>
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
                >
                  Label
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-48"
                >
                  Preview
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
                >
                  Created
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
                >
                  Expiry
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
                >
                  Last accessed
                </th>
                <th
                  scope="col"
                  className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500 w-20"
                >
                  Access count
                </th>
                <th
                  scope="col"
                  className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500 w-24"
                >
                  {/* action column — no heading text */}
                </th>
              </tr>
            </thead>
            <tbody>
              {universeShares.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-neutral-100 dark:border-neutral-800 last:border-0"
                >
                  <th
                    scope="row"
                    className="py-3 pr-4 text-left font-normal text-sm leading-[1.5]"
                  >
                    {s.label ? (
                      s.label
                    ) : (
                      <span className="text-neutral-500 italic">(unnamed)</span>
                    )}
                  </th>
                  <td className="py-3 pr-4 font-mono text-sm leading-[1.5]">
                    {`wbn_share_••••••${s.bodySuffix}`}
                  </td>
                  <td className="py-3 pr-4 text-sm leading-[1.5]">
                    <time
                      dateTime={s.createdAt}
                      title={new Date(s.createdAt).toLocaleString()}
                    >
                      {formatRelative(s.createdAt)}
                    </time>
                  </td>
                  <td className="py-3 pr-4 text-sm leading-[1.5]">
                    {s.expiresAt ? (
                      <time
                        dateTime={s.expiresAt}
                        title={new Date(s.expiresAt).toLocaleString()}
                      >
                        {new Date(s.expiresAt).toLocaleDateString()}
                      </time>
                    ) : (
                      <span className="italic text-neutral-500">No expiry</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-sm leading-[1.5]">
                    {s.lastAccessedAt ? (
                      <time
                        dateTime={s.lastAccessedAt}
                        title={new Date(s.lastAccessedAt).toLocaleString()}
                      >
                        {formatRelative(s.lastAccessedAt)}
                      </time>
                    ) : (
                      <span className="italic text-neutral-500">Never</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums text-sm">
                    {s.accessCount}
                  </td>
                  <td className="py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setRevokeTarget(s)}
                      aria-label={`Revoke share link ${s.label || '(unnamed)'}`}
                      className="text-sm text-neutral-600 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-500"
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

      {/* Create share link dialog — two-phase form → reveal. */}
      <CreateShareLinkDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        universeId={universeId}
      />

      {/* Revoke confirmation — UI-SPEC §Copywriting Contract verbatim. */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title="Revoke share link"
        body={revokeBody}
        confirmLabel="Revoke link"
        cancelLabel="Cancel"
        destructive
        onConfirm={async () => {
          if (revokeTarget) {
            try {
              await revokeShareLink.mutateAsync(revokeTarget.id);
            } catch {
              // Silent invalidate on 404 race — useRevokeShareLink's onError
              // handler reconciles the table on refetch.
            }
          }
        }}
      />
    </section>
  );
}
