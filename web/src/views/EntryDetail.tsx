import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useEntry, useDeleteEntry } from '../hooks/useEntries';
import { TypeBadge } from '../components/TypeBadge';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LinkSection } from '../components/LinkSection';
import { IssueSection } from '../components/IssueSection';

export function EntryDetail() {
  const { uid, entryId } = useParams<{ uid: string; entryId: string }>();
  const navigate = useNavigate();
  const { data: entry, isLoading, refetch } = useEntry(uid!, entryId!);
  const deleteEntry = useDeleteEntry(uid!);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (isLoading || !entry) return <p className="text-sm text-neutral-500">Loading...</p>;

  const handleDelete = async () => {
    await deleteEntry.mutateAsync(entryId!);
    navigate(`/universes/${uid}/entries`, { replace: true });
  };

  const metaEntries = Object.entries(entry.meta as Record<string, string>);

  return (
    <div className="max-w-3xl mx-auto">
      {/* Back link */}
      <Link
        to={`/universes/${uid}/entries`}
        className="text-sm text-neutral-400 hover:text-neutral-200"
      >
        &larr; Back to entries
      </Link>

      {/* Header block */}
      <div className="mt-4">
        <div className="flex items-center gap-3">
          {entry.icon && <span className="text-[28px] leading-none">{entry.icon}</span>}
          <h1 className="text-2xl font-semibold">{entry.title}</h1>
        </div>
        <div className="mt-1">
          <TypeBadge type={entry.entryType} />
        </div>
        <div className="flex gap-2 mt-3">
          <Link
            to={`/universes/${uid}/entries/${entryId}/edit`}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
          >
            Edit
          </Link>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="rounded-md bg-red-600 text-white text-sm px-3 py-1.5"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Summary */}
      {entry.summary && (
        <p className="text-base text-neutral-300 dark:text-neutral-300 mt-4">
          {entry.summary}
        </p>
      )}

      {/* Tags */}
      {entry.tags && entry.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {entry.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-neutral-800 dark:bg-neutral-800 px-2 py-1 text-sm"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Body (Markdown) */}
      {entry.body && (
        <div className="mt-6">
          <MarkdownRenderer content={entry.body} />
        </div>
      )}

      {/* Links + Backlinks */}
      <LinkSection
        outboundLinks={entry.outboundLinks}
        backlinks={entry.backlinks}
        universeId={uid!}
        entryId={entryId!}
        onLinkCreated={() => refetch()}
      />

      {/* Issues (ISS-06: open-only from GET /entries/:id) */}
      <IssueSection
        universeId={uid!}
        entryId={entryId!}
        issues={entry.issues ?? []}
        onChanged={() => refetch()}
      />

      {/* Meta section */}
      {metaEntries.length > 0 && (
        <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
          <h2 className="text-xl font-semibold">Details</h2>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {metaEntries.map(([key, val]) => (
              <div key={key} className="contents">
                <span className="text-sm text-neutral-400">{key}</span>
                <span className="text-sm text-right">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete "${entry.title}"?`}
        body="This permanently removes the entry and all its links. Other entries that link here will lose their connections. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}
