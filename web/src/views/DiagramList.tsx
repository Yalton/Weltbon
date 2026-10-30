import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDiagrams, useDeleteDiagram } from '../hooks/useDiagrams';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { NewDiagramDialog } from '../components/NewDiagramDialog';

// ─── LOCKED copy strings (UI-SPEC §"Diagrams List View") ─────────────────────
const COPY = {
  heading: 'Diagrams',
  ctaNew: 'New diagram',
  emptyHeading: 'No diagrams yet',
  emptyBody:
    'Create a diagram to hand-position entries and draw labeled relationships — great for family trees and org charts.',
  emptyCtaNew: 'New diagram',
  loading: 'Loading diagrams...',
  error: "Couldn't load diagrams. Refresh the page.",
  deleteLabel: 'Delete',
  deleteDialogTitle: (name: string) => `Delete "${name}"?`,
  deleteDialogBody:
    'This removes the diagram and its node positions. The entries and their links in the force-directed graph are not affected.',
  deleteConfirmLabel: 'Delete',
} as const;


export function DiagramList() {
  const { uid } = useParams<{ uid: string }>();
  const { data, isLoading, isError } = useDiagrams(uid!);
  const deleteDiagram = useDeleteDiagram(uid!);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteDiagram.mutateAsync(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Page heading + New diagram CTA */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.heading}</h1>
        <button
          type="button"
          onClick={() => setNewDialogOpen(true)}
          className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-2"
        >
          {COPY.ctaNew}
        </button>
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
            <button
              type="button"
              onClick={() => setNewDialogOpen(true)}
              className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              {COPY.emptyCtaNew}
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {data.map((diagram) => (
            <div
              key={diagram.id}
              className="flex items-center justify-between px-4 py-3 rounded-md border border-line hover:bg-white/[0.03]"
            >
              <a
                href={`/universes/${uid}/diagrams/${diagram.id}`}
                className="flex-1 min-w-0"
              >
                <p className="text-sm font-medium truncate">{diagram.name}</p>
                {diagram.description && (
                  <p className="text-xs text-ink-muted truncate">{diagram.description}</p>
                )}
              </a>
              <button
                type="button"
                aria-label={`Delete ${diagram.name}`}
                onClick={(e) => {
                  e.preventDefault();
                  setDeleteTarget({ id: diagram.id, name: diagram.name });
                }}
                className="ml-4 shrink-0 text-xs text-red-500 hover:text-red-700"
              >
                {COPY.deleteLabel}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* New diagram dialog */}
      <NewDiagramDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        universeId={uid!}
      />

      {/* Delete confirm dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={deleteTarget ? COPY.deleteDialogTitle(deleteTarget.name) : 'Delete diagram?'}
        body={COPY.deleteDialogBody}
        confirmLabel={COPY.deleteConfirmLabel}
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}
