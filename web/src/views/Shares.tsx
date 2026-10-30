
import { useState, type KeyboardEvent } from 'react';
import { Link, NavLink } from 'react-router-dom';
import {
  useShares,
  useRenameShareLink,
  useRevokeShareLink,
  type ShareLink,
} from '../hooks/useShares';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatRelative } from '../utils/formatRelative';

type ShareStatus = 'active' | 'revoked' | 'expired';

function deriveStatus(s: ShareLink): ShareStatus {
  // UI-SPEC §F: revoked wins; otherwise expired if past expiresAt; else active.
  if (s.revokedAt) return 'revoked';
  if (s.expiresAt && new Date(s.expiresAt).getTime() < Date.now()) {
    return 'expired';
  }
  return 'active';
}

export default function Shares() {
  const { data, isPending } = useShares();
  const renameShareLink = useRenameShareLink();
  const revokeShareLink = useRevokeShareLink();

  const [revokeTarget, setRevokeTarget] = useState<ShareLink | null>(null);

  // Inline rename state — UI-SPEC §F: blur OR Enter commits, Escape reverts.
  // T-29-33: NOT on every keystroke (no debounce needed; the semantic intent
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const beginRename = (s: ShareLink) => {
    setRenameTargetId(s.id);
    setRenameValue(s.label);
    setRenameError(null);
  };
  const cancelRename = () => {
    setRenameTargetId(null);
    setRenameValue('');
    setRenameError(null);
  };
  const commitRename = async () => {
    if (!renameTargetId) return;
    try {
      await renameShareLink.mutateAsync({
        id: renameTargetId,
        label: renameValue.trim(),
      });
      setRenameTargetId(null);
      setRenameValue('');
      setRenameError(null);
    } catch {
      // UI-SPEC §Copywriting Contract §Error States verbatim.
      setRenameError("Couldn't save. Try again.");
    }
  };
  const onRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };

  // UI-SPEC §Copywriting Contract §Destructive Confirmations verbatim.
  const revokeBody = revokeTarget
    ? revokeTarget.label
      ? `Revoking "${revokeTarget.label}" makes it immediately invalid. Anyone with the link will see a "not found" page. This can't be undone.`
      : `Revoking this share link makes it immediately invalid. Anyone with the link will see a "not found" page. This can't be undone.`
    : '';

  return (
    <div className="max-w-3xl">
      {/* Page header — no "New share link" button per UI-SPEC §F. */}
      <h1 className="text-2xl font-semibold tracking-tight">Share links</h1>

      {/* Intro paragraph — UI-SPEC §F + §Copywriting Contract verbatim. */}
      <p className="mt-2 text-sm text-ink-secondary leading-[1.5]">
        Share links give anyone with the URL read-only access to a universe. Manage all your active links here, or create new ones from a{' '}
        <Link
          to="/universes"
          className="text-[color:var(--color-accent)] hover:underline"
        >
          universe&apos;s settings page
        </Link>
        .
      </p>

      {/* Loading state — 3 skeleton rows. */}
      {isPending && (
        <div
          className="mt-6 space-y-2"
          aria-busy="true"
          aria-label="Loading share links"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-md bg-raised animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state — UI-SPEC §F: NO action button (creation is on
          UniverseSettings, not here). */}
      {!isPending && data && data.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No share links yet"
            body="Create a share link from any universe's settings page to let someone browse it without an account."
          />
        </div>
      )}

      {/* Populated state — semantic table. UI-SPEC §F columns + accessibility. */}
      {!isPending && data && data.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Your share links</caption>
            <thead>
              <tr className="border-b border-line">
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-40"
                >
                  Universe
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted"
                >
                  Label
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-24"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-48"
                >
                  Preview
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-32"
                >
                  Created
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-32"
                >
                  Last accessed
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted w-32"
                >
                  Expiry
                </th>
                <th
                  scope="col"
                  className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-ink-muted w-20"
                >
                  Access count
                </th>
                <th
                  scope="col"
                  className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-ink-muted w-24"
                >
                  {/* Actions — no heading text. */}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => {
                const status = deriveStatus(s);
                const isRenaming = renameTargetId === s.id;
                return (
                  <tr
                    key={s.id}
                    className={[
                      'border-b border-line last:border-0',
                      status === 'revoked' ? 'opacity-50' : '',
                    ].join(' ')}
                  >
                    {/* Universe — linked to /universes/:id/settings?tab=share-links. */}
                    <td className="py-3 pr-4 text-sm leading-[1.5]">
                      <NavLink
                        to={`/universes/${s.universeId}/settings?tab=share-links`}
                        className="text-[color:var(--color-accent)] hover:underline"
                      >
                        {s.universeName}
                      </NavLink>
                    </td>

                    {/* Label cell — row header for screen reader semantics +
                        inline rename UX. */}
                    <th
                      scope="row"
                      className={`py-3 pr-4 text-left font-normal text-sm leading-[1.5]${status === 'revoked' ? ' line-through' : ''}`}
                    >
                      {isRenaming ? (
                        <div>
                          <input
                            type="text"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={() => void commitRename()}
                            onKeyDown={onRenameKeyDown}
                            autoFocus
                            maxLength={100}
                            aria-label="Rename share link"
                            className="w-full rounded-md border border-line-strong bg-transparent px-2 py-1 text-sm"
                          />
                          {renameError && (
                            <p
                              className="mt-1 text-sm text-red-500"
                              role="alert"
                            >
                              {renameError}
                            </p>
                          )}
                        </div>
                      ) : status === 'active' ? (
                        <button
                          type="button"
                          onClick={() => beginRename(s)}
                          className="text-left hover:underline focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2 rounded-sm"
                          aria-label={`Rename share link ${s.label || '(unnamed)'}`}
                        >
                          {s.label ? (
                            s.label
                          ) : (
                            <span className="text-ink-muted italic">
                              (unnamed)
                            </span>
                          )}
                        </button>
                      ) : s.label ? (
                        s.label
                      ) : (
                        <span className="text-ink-muted italic">
                          (unnamed)
                        </span>
                      )}
                    </th>

                    {/* Status chip — three STATIC JSX branches per UI-SPEC §F
                        (no dynamic class concat — Tailwind JIT safety). */}
                    <td className="py-3 pr-4">
                      {status === 'active' && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
                          active
                        </span>
                      )}
                      {status === 'revoked' && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400">
                          revoked
                        </span>
                      )}
                      {status === 'expired' && (
                        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-raised text-ink-muted">
                          expired
                        </span>
                      )}
                    </td>

                    {/* Masked preview. */}
                    <td className="py-3 pr-4 font-mono text-sm leading-[1.5]">
                      {`wbn_share_••••••${s.bodySuffix}`}
                    </td>

                    {/* Created. */}
                    <td className="py-3 pr-4 text-sm leading-[1.5]">
                      <time
                        dateTime={s.createdAt}
                        title={new Date(s.createdAt).toLocaleString()}
                      >
                        {formatRelative(s.createdAt)}
                      </time>
                    </td>

                    {/* Last accessed. */}
                    <td className="py-3 pr-4 text-sm leading-[1.5]">
                      {s.lastAccessedAt ? (
                        <time
                          dateTime={s.lastAccessedAt}
                          title={new Date(s.lastAccessedAt).toLocaleString()}
                        >
                          {formatRelative(s.lastAccessedAt)}
                        </time>
                      ) : (
                        <span className="italic text-ink-muted">Never</span>
                      )}
                    </td>

                    {/* Expiry. */}
                    <td className="py-3 pr-4 text-sm leading-[1.5]">
                      {s.expiresAt ? (
                        <time
                          dateTime={s.expiresAt}
                          title={new Date(s.expiresAt).toLocaleString()}
                        >
                          {new Date(s.expiresAt).toLocaleDateString()}
                        </time>
                      ) : (
                        <span className="italic text-ink-muted">No expiry</span>
                      )}
                    </td>

                    {/* Access count — right-aligned tabular numerals. */}
                    <td className="py-3 pr-4 text-right tabular-nums text-sm">
                      {s.accessCount}
                    </td>

                    {/* Actions — Revoke text-button on active rows only. */}
                    <td className="py-3 text-right">
                      {status === 'active' && (
                        <button
                          type="button"
                          onClick={() => setRevokeTarget(s)}
                          aria-label={`Revoke share link ${s.label || '(unnamed)'}`}
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
            }
          }
        }}
      />
    </div>
  );
}
