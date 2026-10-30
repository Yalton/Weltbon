import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreateMap } from '../hooks/useMaps';
import { useAssets } from '../hooks/useAssets';
import { AssetPickerModal } from './AssetPickerModal';

// ─── LOCKED copy strings (UI-SPEC §"New Map Dialog" + Copywriting Contract) ──
const COPY = {
  dialogTitle: 'New map',
  fieldName: 'Name',
  placeholderName: 'The Shattered Continent',
  fieldImage: 'Map image',
  imageButtonNone: 'Select image',
  imageButtonSelected: 'Change image',
  ctaCreate: 'Create map',
  ctaPending: 'Creating...',
  cancel: 'Discard',
  validationName: 'Enter a name for this map.',
  validationImage: 'Select a map image to continue.',
  saveFailed: "Couldn't create map. Try again.",
} as const;


interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
}

type FieldError = 'name' | 'image' | 'save' | null;

export function NewMapDialog({ open, onOpenChange, universeId }: Props) {
  const createMap = useCreateMap(universeId);
  const { data: assets } = useAssets(universeId);

  const nameId = useId();
  const imageId = useId();

  const [nameInput, setNameInput] = useState('');
  const [imageAssetId, setImageAssetId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errorField, setErrorField] = useState<FieldError>(null);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNameInput('');
      setImageAssetId(null);
      setPickerOpen(false);
      setErrorField(null);
      setErrorCopy(null);
    }
  }, [open]);

  const selectedAsset = assets?.find((a) => a.id === imageAssetId) ?? null;
  const imageThumbnailUrl = selectedAsset?.thumbUrl ?? null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!nameInput.trim()) {
      setErrorField('name');
      setErrorCopy(COPY.validationName);
      return;
    }

    if (!imageAssetId) {
      setErrorField('image');
      setErrorCopy(COPY.validationImage);
      return;
    }

    setErrorField(null);
    setErrorCopy(null);

    try {
      await createMap.mutateAsync({ name: nameInput.trim(), imageAssetId });
      onOpenChange(false);
    } catch {
      setErrorField('save');
      setErrorCopy(COPY.saveFailed);
    }
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-panel border border-line rounded-md p-6 shadow-lg z-50 data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
            <Dialog.Title className="text-lg font-semibold">
              {COPY.dialogTitle}
            </Dialog.Title>

            <form onSubmit={onSubmit} className="mt-4 space-y-3">
              {/* Name (required) */}
              <div>
                <label htmlFor={nameId} className="block text-sm mb-1">
                  {COPY.fieldName}
                </label>
                <input
                  id={nameId}
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder={COPY.placeholderName}
                  autoFocus
                  className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                />
                {errorField === 'name' && errorCopy && (
                  <p className="mt-1 text-xs text-red-500" role="alert">
                    {errorCopy}
                  </p>
                )}
              </div>

              {/* Map image (required) */}
              <div>
                <label htmlFor={imageId} className="block text-sm mb-1">
                  {COPY.fieldImage}
                </label>
                <button
                  id={imageId}
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="rounded-md border border-line-strong text-sm px-3 py-1.5 hover:bg-white/5"
                >
                  {imageAssetId ? COPY.imageButtonSelected : COPY.imageButtonNone}
                </button>

                {/* Thumbnail preview once an image is selected */}
                {imageThumbnailUrl && (
                  <img
                    src={imageThumbnailUrl}
                    alt="Selected map image"
                    className="mt-2 w-16 h-16 rounded-md border border-line object-cover"
                  />
                )}

                {errorField === 'image' && errorCopy && (
                  <p className="mt-1 text-xs text-red-500" role="alert">
                    {errorCopy}
                  </p>
                )}
              </div>

              {/* Save-level error */}
              {errorField === 'save' && errorCopy && (
                <p className="text-xs text-red-500" role="alert">
                  {errorCopy}
                </p>
              )}

              <div className="mt-6 flex justify-end gap-2">
                <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-line-strong">
                  {COPY.cancel}
                </Dialog.Close>
                <button
                  type="submit"
                  disabled={createMap.isPending || !nameInput.trim() || !imageAssetId}
                  className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white disabled:opacity-50"
                >
                  {createMap.isPending ? COPY.ctaPending : COPY.ctaCreate}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* AssetPickerModal rendered outside the main Dialog.Root to avoid nested portal z-index issues */}
      <AssetPickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        universeId={universeId}
        mode="set-cover"
        onSelect={(assetId) => {
          setImageAssetId(assetId);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
