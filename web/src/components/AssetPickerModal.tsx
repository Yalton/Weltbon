import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAssets, useUploadAsset, type AssetSummary } from '../hooks/useAssets';

// ─── LOCKED copy strings (UI-SPEC §"Asset Picker Modal") ─────────────────────
const COPY = {
  titleInsert: 'Insert image',
  titleCover: 'Set cover image',
  uploadLabel: 'Upload new image',
  uploadAccept: 'PNG, JPEG, WebP, GIF',
  uploading: 'Uploading...',
  selectButton: 'Insert',
  selectButtonCover: 'Set as cover',
  cancel: 'Cancel',
  loading: 'Loading images...',
  empty: 'No images uploaded yet.',
  uploadFailed: "Couldn't upload image. Try again.",
} as const;
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
  mode: 'insert-embed' | 'set-cover';
  onSelect: (assetId: string) => void;
}

export function AssetPickerModal({
  open,
  onOpenChange,
  universeId,
  mode,
  onSelect,
}: Props) {
  const { data: assets, isLoading } = useAssets(universeId);
  const uploadAsset = useUploadAsset(universeId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelected(null);
      setUploadError(null);
    }
  }, [open]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    try {
      const uploaded = await uploadAsset.mutateAsync(file);
      // Auto-select the newly uploaded asset
      setSelected(uploaded.id);
    } catch {
      setUploadError(COPY.uploadFailed);
    }
    e.target.value = '';
  };

  const handleSelect = () => {
    if (!selected) return;
    onSelect(selected);
    onOpenChange(false);
  };

  const dialogTitle = mode === 'insert-embed' ? COPY.titleInsert : COPY.titleCover;
  const selectLabel = mode === 'insert-embed' ? COPY.selectButton : COPY.selectButtonCover;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-xl max-h-[80vh] flex flex-col bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold shrink-0">
            {dialogTitle}
          </Dialog.Title>

          {/* Upload new section (D-05: upload from inside modal) */}
          <div className="mt-4 shrink-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadAsset.isPending}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
            >
              {uploadAsset.isPending ? COPY.uploading : COPY.uploadLabel}
            </button>
            <span className="ml-2 text-xs text-neutral-400">{COPY.uploadAccept}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleUpload}
            />
            {uploadError && (
              <p className="mt-1 text-xs text-red-500" role="alert">
                {uploadError}
              </p>
            )}
          </div>

          {/* Asset grid browse */}
          <div className="mt-4 flex-1 overflow-y-auto">
            {isLoading ? (
              <p className="text-sm text-neutral-500">{COPY.loading}</p>
            ) : !assets || assets.length === 0 ? (
              <p className="text-sm text-neutral-500">{COPY.empty}</p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {assets.map((asset: AssetSummary) => (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => setSelected(asset.id)}
                    className={[
                      'relative rounded-md overflow-hidden border-2 aspect-square focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]',
                      selected === asset.id
                        ? 'border-[color:var(--color-accent)]'
                        : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-400 dark:hover:border-neutral-500',
                    ].join(' ')}
                    aria-label={`Select ${asset.filename}`}
                    aria-pressed={selected === asset.id}
                  >
                    <img
                      src={asset.thumbUrl}
                      alt={asset.altText ?? asset.filename}
                      className="w-full h-full object-contain bg-neutral-100 dark:bg-neutral-800"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                    {selected === asset.id && (
                      <div className="absolute inset-0 bg-[color:var(--color-accent)]/20 flex items-center justify-center">
                        <svg
                          viewBox="0 0 16 16"
                          width="20"
                          height="20"
                          fill="currentColor"
                          className="text-[color:var(--color-accent)] drop-shadow"
                          aria-hidden="true"
                        >
                          <path
                            fillRule="evenodd"
                            d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"
                          />
                        </svg>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="mt-4 flex justify-end gap-2 shrink-0 border-t border-neutral-200 dark:border-neutral-800 pt-4">
            <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700">
              {COPY.cancel}
            </Dialog.Close>
            <button
              type="button"
              disabled={!selected}
              onClick={handleSelect}
              className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50"
            >
              {selectLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
