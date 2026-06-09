import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { OutboundLink, Backlink } from '../hooks/useEntries';
import { useDeleteLink } from '../hooks/useLinks';
import { getInverseLabel, formatLinkType } from '../lib/linkTypeColor';
import type { LinkTypeRegistry } from '../lib/linkTypeColor';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { LinkEditor } from './LinkEditor';

interface Props {
  outboundLinks: OutboundLink[];
  backlinks: Backlink[];
  universeId: string;
  entryId: string;
  onLinkCreated: () => void;
  /**
   * Per-universe link type registry for color/inverse overrides.
   * Passed as {} when the universe data is not yet loaded — preset
   * inverses from PRESET_LINK_TYPES are still applied (safe default).
   */
  linkTypeRegistry?: LinkTypeRegistry;
}

export function LinkSection({
  outboundLinks,
  backlinks,
  universeId,
  entryId,
  onLinkCreated,
  linkTypeRegistry = {},
}: Props) {
  const deleteLink = useDeleteLink(universeId);
  const [deletingLinkId, setDeletingLinkId] = useState<string | null>(null);

  // Group outbound links by linkType, falling back to label, then 'untyped'
  const grouped = outboundLinks.reduce<Record<string, OutboundLink[]>>((acc, link) => {
    const key = link.linkType ?? link.label ?? 'untyped';
    if (!acc[key]) acc[key] = [];
    acc[key].push(link);
    return acc;
  }, {});

  // Filter out backlinks for undirected links that already appear in outbound
  // (an undirected link appears on both sides; dedup by id to avoid duplicate display)
  const outboundIds = new Set(outboundLinks.map((l) => l.id));
  const filteredBacklinks = backlinks.filter(
    (bl) => !(bl.direction === 'undirected' && outboundIds.has(bl.id)),
  );

  const handleDeleteLink = async () => {
    if (!deletingLinkId) return;
    await deleteLink.mutateAsync(deletingLinkId);
    setDeletingLinkId(null);
    onLinkCreated();
  };

  const hasOutbound = outboundLinks.length > 0;

  return (
    <>
      {/* Outbound Links */}
      <div className="mt-8 pt-6 border-t border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Links</h2>
          {hasOutbound && (
            <LinkEditor universeId={universeId} entryId={entryId} onLinkCreated={onLinkCreated}>
              <button
                type="button"
                className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
              >
                Add link
              </button>
            </LinkEditor>
          )}
        </div>

        {hasOutbound ? (
          <div className="mt-4 space-y-4">
            {Object.entries(grouped).map(([linkTypeKey, links]) => (
              <div key={linkTypeKey}>
                {/* Group heading (UI-SPEC Surface 2 + "New Surfaces — typed group heading") */}
                <p className="text-xs text-neutral-400 uppercase tracking-wide">
                  {linkTypeKey === 'untyped'
                    ? (links[0]?.label ?? 'Linked')
                    : formatLinkType(linkTypeKey)}
                  {/* Append freeform label as secondary if different from the type key */}
                  {links[0]?.label && linkTypeKey !== 'untyped' && linkTypeKey !== links[0].label
                    ? <span className="text-neutral-500 italic ml-1">— {links[0].label}</span>
                    : null}
                </p>
                <ul className="mt-1 space-y-1">
                  {links.map((link) => (
                    <li key={link.id} className="flex items-center gap-2 group">
                      <Link
                        to={`/universes/${universeId}/entries/${link.targetEntryId}`}
                        className="text-sm text-[color:var(--color-accent)] hover:underline flex items-center gap-1"
                      >
                        {link.targetIcon && <span>{link.targetIcon}</span>}
                        {link.targetTitle}
                      </Link>
                      <button
                        type="button"
                        onClick={() => setDeletingLinkId(link.id)}
                        className="text-neutral-500 hover:text-red-500 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label="Remove link"
                      >
                        &times;
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No links yet"
            body="Link this entry to others to build your world's connections."
            action={
              <LinkEditor universeId={universeId} entryId={entryId} onLinkCreated={onLinkCreated}>
                <button
                  type="button"
                  className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-4 py-2"
                >
                  Add link
                </button>
              </LinkEditor>
            }
          />
        )}
      </div>

      {/* Backlinks */}
      <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
        <h2 className="text-xl font-semibold">Backlinks</h2>
        {filteredBacklinks.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {filteredBacklinks.map((bl) => (
              <li key={bl.id} className="flex items-center gap-2">
                <Link
                  to={`/universes/${universeId}/entries/${bl.sourceEntryId}`}
                  className="text-sm text-[color:var(--color-accent)] hover:underline flex items-center gap-1"
                >
                  {bl.sourceIcon && <span>{bl.sourceIcon}</span>}
                  {bl.sourceTitle}
                </Link>
                {/* Backlink inverse label: derived from linkType if preset; falls back to freeform label */}
                <span className="text-xs text-neutral-400 ml-2">
                  {getInverseLabel(bl.linkType, linkTypeRegistry) ?? bl.label ?? ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500 mt-2">No other entries link to this one.</p>
        )}
      </div>

      {/* Delete link confirmation */}
      <ConfirmDialog
        open={deletingLinkId !== null}
        onOpenChange={(open) => { if (!open) setDeletingLinkId(null); }}
        title="Remove this link?"
        body="This removes the connection between these two entries. You can recreate it later."
        confirmLabel="Remove"
        destructive
        onConfirm={handleDeleteLink}
      />
    </>
  );
}
