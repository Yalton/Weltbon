import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  useAssets,
  useUploadAsset,
  useDeleteAsset,
  useRenameAsset,
  useAssetUsage,
  type AssetSummary,
} from '../hooks/useAssets';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';

// ─── LOCKED copy strings (UI-SPEC §"Asset Library View") ─────────────────────
const COPY = {
  heading: 'Media',
  ctaUpload: 'Upload image',
  emptyHeading: 'No images yet',
  emptyBody:
    'Upload images to use as entry cover photos or inline embeds in your entry bodies.',
  emptyCtaUpload: 'Upload image',
  loading: 'Loading media...',
  error: "Couldn't load media. Refresh the page.",
  deleteLabel: 'Delete',
  renameLabel: 'Rename',
  deleteDialogTitle: (name: string) => `Delete "${name}"?`,
  deleteDialogBodyNoRefs: 'This permanently removes the image.',
  deleteDialogBodyWithRefs: (n: number) =>
    `${n} ${n === 1 ? 'entry references' : 'entries reference'} this image. Inline embeds will show a broken placeholder; cover image references will be cleared automatically. This cannot be undone.`,
  deleteConfirmLabel: 'Delete',
} as const;

function AssetCard({
  asset,
  uid,
  onDeleteClick,
}: {
  asset: AssetSummary;
  uid: string;
  onDeleteClick: (a: AssetSummary) => void;
}) {
  const renameAsset = useRenameAsset(uid);
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(asset.filename);

  const commitRename = async () => {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== asset.filename) {
      await renameAsset.mutateAsync({ assetId: asset.id, filename: trimmed });
    } else {
      setNameInput(asset.filename);
    }
    setEditing(false);
  };

  return (
    <div className="relative rounded-md border border-line overflow-hidden bg-panel">
      {/* Thumbnail */}
      <div className="aspect-square flex items-center justify-center bg-raised">
        <img
          src={asset.thumbUrl}
          alt={asset.altText ?? asset.filename}
          className="w-full h-full object-contain"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      </div>

      {/* Filename + actions */}
      <div className="p-2">
        {editing ? (
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setNameInput(asset.filename);
                setEditing(false);
              }
            }}
            autoFocus
            className="w-full rounded border border-line-strong bg-transparent px-1 py-0.5 text-xs"
          />
        ) : (
          <p
            className="text-xs truncate cursor-pointer hover:text-[color:var(--color-accent)]"
            onClick={() => setEditing(true)}
            title={asset.filename}
          >
            {asset.filename}
          </p>
        )}
        <div className="flex gap-2 mt-1">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-ink-secondary hover:text-ink"
          >
            {COPY.renameLabel}
          </button>
          <button
            type="button"
            onClick={() => onDeleteClick(asset)}
            className="text-xs text-red-500 hover:text-red-700"
          >
            {COPY.deleteLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AssetLibrary() {
  const { uid } = useParams<{ uid: string }>();
  const { data, isLoading, isError } = useAssets(uid!);
  const uploadAsset = useUploadAsset(uid!);
  const deleteAsset = useDeleteAsset(uid!);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<AssetSummary | null>(null);

  // Fetch usage for the delete target only when a target is selected (D-12)
  const { data: usageData } = useAssetUsage(uid!, deleteTarget?.id ?? null);
  // WR-01: API returns {count, references} — use .count directly (not .entries?.length).
  const usageCount = usageData?.count ?? 0;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadAsset.mutateAsync(file);
    // Reset so same file can be re-selected
    e.target.value = '';
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteAsset.mutateAsync(deleteTarget.id);
    setDeleteTarget(null);
  };

  const deleteDialogBody =
    usageCount > 0
      ? COPY.deleteDialogBodyWithRefs(usageCount)
      : COPY.deleteDialogBodyNoRefs;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Page heading + upload CTA */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.heading}</h1>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadAsset.isPending}
          className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-2 disabled:opacity-50"
        >
          {uploadAsset.isPending ? 'Uploading...' : COPY.ctaUpload}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={handleFileChange}
        />
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
              onClick={() => fileInputRef.current?.click()}
              className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              {COPY.emptyCtaUpload}
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {data.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              uid={uid!}
              onDeleteClick={setDeleteTarget}
            />
          ))}
        </div>
      )}

      {/* Delete confirm dialog (D-12: shows usage count when references > 0) */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={deleteTarget ? COPY.deleteDialogTitle(deleteTarget.filename) : 'Delete image?'}
        body={deleteDialogBody}
        confirmLabel={COPY.deleteConfirmLabel}
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}
