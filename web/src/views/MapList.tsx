import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMaps, useDeleteMap } from '../hooks/useMaps';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { NewMapDialog } from '../components/NewMapDialog';
import { useShareMode, useShareToken } from '../contexts/ShareModeContext';

// ─── LOCKED copy strings (UI-SPEC §"Map List" + Copywriting Contract) ────────
const COPY = {
  heading: 'Maps',
  ctaNew: 'New map',
  emptyHeading: 'No maps yet',
  emptyBody: 'Create a map to place entry pins and explore your world spatially.',
  emptyCtaNew: 'New map',
  loading: 'Loading maps...',
  error: "Couldn't load maps. Refresh the page.",
  deleteDialogTitle: (name: string) => `Delete "${name}"?`,
  deleteDialogBody:
    'This removes the map and all its pins. The linked entries are not affected.',
  deleteConfirmLabel: 'Delete map',
} as const;


export function MapList() {
  const { uid: paramUid } = useParams<{ uid: string }>();
  const isShare = useShareMode();
  const shareToken = useShareToken();
  const uid = paramUid ?? (isShare ? 'share' : '');
  const navigate = useNavigate();
  const { data, isLoading, isError } = useMaps(uid!);
  const deleteMap = useDeleteMap(uid!);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteMap.mutateAsync(deleteTarget.id);
    setDeleteTarget(null);
  };

  // Navigate to a map detail — share-token-aware (T-40-14).
  const navigateToMap = (mapId: string) => {
    if (shareToken) {
      navigate(`/share/${shareToken}/maps/${mapId}`);
    } else {
      navigate(`/universes/${uid}/maps/${mapId}`);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Page heading + New map CTA — CTA suppressed in share mode */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.heading}</h1>
        {!isShare && (
          <button
            type="button"
            onClick={() => setNewDialogOpen(true)}
            className="rounded-md btn-accent text-sm px-3 py-2"
          >
            {COPY.ctaNew}
          </button>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <p className="text-sm text-ink-muted">{COPY.loading}</p>
      ) : isError ? (
        <p className="text-sm text-red-500">{COPY.error}</p>
      ) : !data || data.length === 0 ? (
        <EmptyState
          title={COPY.emptyHeading}
          body={COPY.emptyBody}
          action={
            !isShare ? (
              <button
                type="button"
                onClick={() => setNewDialogOpen(true)}
                className="btn-accent text-sm px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                {COPY.emptyCtaNew}
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {data.map((map) => (
            <div
              key={map.id}
              className="rounded-md border border-line-strong hover:border-[color:var(--color-ink-muted)] overflow-hidden transition-colors"
            >
              {/* Tile image — clickable to navigate to map detail */}
              <button
                type="button"
                onClick={() => navigateToMap(map.id)}
                className="block w-full focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                aria-label={`Open map ${map.name}`}
              >
                <img
                  src={map.thumbUrl ?? ''}
                  alt={map.name}
                  className="w-full aspect-video object-cover bg-raised"
                />
              </button>

              {/* Tile footer: name + delete (delete suppressed in share mode) */}
              <div className="flex items-center justify-between px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => navigateToMap(map.id)}
                  className="flex-1 min-w-0 text-left focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] rounded"
                >
                  <p className="text-sm font-semibold truncate">{map.name}</p>
                </button>
                {!isShare && (
                  <button
                    type="button"
                    aria-label={`Delete ${map.name}`}
                    onClick={() => setDeleteTarget({ id: map.id, name: map.name })}
                    className="ml-2 shrink-0 text-xs text-red-500 hover:text-red-700"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New map dialog — not rendered in share mode */}
      {!isShare && (
        <NewMapDialog
          open={newDialogOpen}
          onOpenChange={setNewDialogOpen}
          universeId={uid!}
        />
      )}

      {/* Delete confirm dialog — not rendered in share mode */}
      {!isShare && (
        <ConfirmDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          title={deleteTarget ? COPY.deleteDialogTitle(deleteTarget.name) : 'Delete map?'}
          body={COPY.deleteDialogBody}
          confirmLabel={COPY.deleteConfirmLabel}
          destructive
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}
