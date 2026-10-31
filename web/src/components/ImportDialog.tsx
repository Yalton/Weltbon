import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { api } from '../api/client';
import { formatBytes, classifyError } from '../lib/format';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ImportResult {
  universeId: string;
  universeName: string;
  entryCount: number;
  linkCount: number;
}

type State =
  | { step: 'idle' }
  | { step: 'selected'; file: File }
  | { step: 'loading' }
  | { step: 'success'; result: ImportResult }
  | { step: 'error'; message: string; file: File };

export function ImportDialog({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ step: 'idle' });

  const reset = () => setState({ step: 'idle' });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setState({ step: 'selected', file });
  };

  const handleRemoveFile = () => {
    setState({ step: 'idle' });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImport = async () => {
    const file = state.step === 'selected' ? state.file : state.step === 'error' ? state.file : null;
    if (!file) return;

    setState({ step: 'loading' });

    try {
      const text = await file.text();
      JSON.parse(text);

      const result = await api<ImportResult>('/universes/import', {
        method: 'POST',
        body: text,
      });

      setState({ step: 'success', result });
    } catch (err) {
      setState({ step: 'error', message: classifyError(err), file });
    }
  };

  const handleDone = () => {
    if (state.step === 'success') {
      const uid = state.result.universeId;
      reset();
      onOpenChange(false);
      navigate(`/universes/${uid}/entries`);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-panel border border-line rounded-md p-6 shadow-lg z-50 data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">
            Import universe from JSON
          </Dialog.Title>

          <div className="mt-4">
            {/* Error banner */}
            {state.step === 'error' && (
              <div className="bg-red-600 text-white rounded-md p-3 text-sm mb-4">
                {state.message}
              </div>
            )}

            {/* Success state */}
            {state.step === 'success' ? (
              <div className="space-y-4">
                <p className="text-sm text-emerald-500">
                  Imported {state.result.entryCount} entries and {state.result.linkCount} links
                  into &quot;{state.result.universeName}&quot;.
                </p>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleDone}
                    className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {/* File upload area */}
                {(state.step === 'idle' || state.step === 'loading') && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={state.step === 'loading'}
                    className="w-full border-2 border-dashed border-line-strong rounded-md p-8 text-center text-sm text-ink-secondary hover:border-line-strong transition-colors cursor-pointer disabled:cursor-not-allowed"
                  >
                    Drop a .json file here or click to browse
                  </button>
                )}

                {/* File selected state */}
                {(state.step === 'selected' || state.step === 'error') && (
                  <div className="flex items-center justify-between rounded-md border border-line px-4 py-3">
                    <div className="text-sm">
                      <p className="font-semibold truncate max-w-[260px]">
                        {(state.step === 'selected' ? state.file : state.file).name}
                      </p>
                      <p className="text-ink-secondary">
                        {formatBytes((state.step === 'selected' ? state.file : state.file).size)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleRemoveFile}
                      className="text-sm text-ink-secondary hover:text-ink"
                    >
                      Remove
                    </button>
                  </div>
                )}

                {/* Loading spinner */}
                {state.step === 'loading' && (
                  <div className="flex items-center gap-2 text-sm text-ink-secondary">
                    <span className="inline-block h-4 w-4 border-2 border-[color:var(--color-ink-muted)] border-t-transparent rounded-full animate-spin" />
                    Importing...
                  </div>
                )}

                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileChange}
                  className="hidden"
                />

                {/* Actions */}
                <div className="flex justify-end gap-2">
                  <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-line-strong">
                    Cancel
                  </Dialog.Close>
                  <button
                    type="button"
                    onClick={handleImport}
                    disabled={state.step !== 'selected' && state.step !== 'error'}
                    className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Import
                  </button>
                </div>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
