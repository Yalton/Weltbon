import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useImportDictionaryCsv, type ImportResult } from '../hooks/useDictionary';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
  lid: string | null;
  onImported: (result: { inserted: number; updated: number }) => void;
  /** Optional word to prefill the add-word flow (from unresolved [[word]] affordance). */
  prefillWord?: string;
  /** Test-only: pre-set row errors to display (used by DictionaryTable.test.tsx). */
  _testRowErrors?: { row: number; message: string }[];
  /** Test-only: pre-set import result to display. */
  _testImportResult?: { inserted: number; updated: number };
}

// ─── DictionaryImportDialog ──────────────────────────────────────────────────

/**
 * Phase 32 Plan 03 — CSV import dialog.
 *
 * Uses @radix-ui/react-dialog (same shell as ConfirmDialog.tsx).
 *
 * States:
 *   - Idle: file picker + format hint
 *   - File selected: file name displayed, Import button enabled
 *   - Importing: button shows "Importing…", inputs disabled
 *   - Success (no errors): close + parent toasts "Imported N word(s)"
 *   - Success (with row errors): inline error list + summary
 *   - Error — file too large: inline error (client-side guard, T-32-10)
 *   - Error — missing headers: inline error
 *
 * Dialog animation: animate-dialog-in / animate-dialog-out (UI-SPEC tokens).
 *
 * prefillWord (Plan 04 affordance): when set, documented as deferred to
 * open-add-row flow in the parent Dictionary view (not a full word form here).
 * See SUMMARY.md for the decision.
 *
 * UI-SPEC compliance:
 *   - Exactly 2 font weights (400/600)
 *   - Copywriting Contract copy strings
 *   - animate-dialog-in / animate-dialog-out animation tokens
 */
export function DictionaryImportDialog({
  open,
  onOpenChange,
  universeId,
  lid,
  onImported,
  _testRowErrors,
  _testImportResult,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [fileSizeError, setFileSizeError] = useState(false);
  const [rowErrors, setRowErrors] = useState<{ row: number; message: string }[]>(
    _testRowErrors ?? [],
  );
  const [importResult, setImportResult] = useState<{
    inserted: number;
    updated: number;
  } | null>(_testImportResult ?? null);
  const [missingHeadersError, setMissingHeadersError] = useState(false);

  const importMutation = useImportDictionaryCsv(universeId, lid);
  const isImporting = importMutation.isPending;

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFileSizeError(false);
    setRowErrors([]);
    setImportResult(null);
    setMissingHeadersError(false);

    if (!selected) {
      setFile(null);
      return;
    }

    // Client-side size guard (T-32-10 mitigate; server enforces authoritatively)
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    if (selected.size > MAX_SIZE) {
      setFileSizeError(true);
      setFile(null);
      return;
    }

    setFile(selected);
  }

  async function handleImport() {
    if (!file) return;

    try {
      const result = await importMutation.mutateAsync(file);
      setRowErrors(result.rowErrors ?? []);
      setImportResult({ inserted: result.inserted, updated: result.updated });

      if (!result.rowErrors || result.rowErrors.length === 0) {
        // Success with no errors: close and surface toast in parent
        onImported({ inserted: result.inserted, updated: result.updated });
        onOpenChange(false);
        reset();
      }
      // Success with row errors: stay open and show inline errors
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('missing') && msg.toLowerCase().includes('column')) {
        setMissingHeadersError(true);
      } else {
        setRowErrors([{ row: 0, message: msg }]);
      }
    }
  }

  function reset() {
    setFile(null);
    setFileSizeError(false);
    setRowErrors([]);
    setImportResult(null);
    setMissingHeadersError(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canImport = !!file && !isImporting && !fileSizeError;
  const hasResult = importResult !== null;
  const hasRowErrors = rowErrors.length > 0;

  // Format hint — which language scope this import targets
  const scopeHint = lid
    ? 'Importing into the selected language dictionary.'
    : 'Importing into the universe-level dictionary.';

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md p-6 shadow-lg data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
          <Dialog.Title className="text-lg font-semibold">Import CSV</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-neutral-500">
            {scopeHint}
          </Dialog.Description>

          {/* Format hint */}
          <div className="mt-4 rounded-md bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 p-3 text-xs text-neutral-600 dark:text-neutral-400">
            <p className="font-semibold mb-1">CSV format</p>
            <p>
              Required columns: <code className="font-mono">word</code>,{' '}
              <code className="font-mono">gloss</code>
            </p>
            <p className="mt-0.5">
              Optional columns:{' '}
              <code className="font-mono">ipa</code>,{' '}
              <code className="font-mono">pos</code>,{' '}
              <code className="font-mono">etymology</code>,{' '}
              <code className="font-mono">tags</code>
            </p>
            <p className="mt-0.5">
              Tags are semicolon-delimited: <code className="font-mono">nature;common</code>
            </p>
            <p className="mt-0.5">Column headers are case-insensitive; extra columns are ignored.</p>
          </div>

          {/* File picker */}
          <div className="mt-4">
            <label
              htmlFor="csv-file-input"
              className="block text-sm font-semibold mb-1"
            >
              CSV file
            </label>
            <input
              id="csv-file-input"
              type="file"
              accept=".csv"
              disabled={isImporting}
              onChange={handleFileChange}
              className="block w-full text-sm text-neutral-600 dark:text-neutral-400 file:mr-3 file:py-1 file:px-2 file:rounded-md file:border file:border-neutral-300 dark:file:border-neutral-600 file:text-sm file:bg-neutral-50 dark:file:bg-neutral-800 file:cursor-pointer disabled:opacity-50"
            />
            {file && (
              <p className="mt-1 text-xs text-neutral-500">{file.name}</p>
            )}
          </div>

          {/* File-too-large error (T-32-10 mitigate) */}
          {fileSizeError && (
            <div
              role="alert"
              className="mt-3 rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300"
            >
              File too large. Maximum size is 5 MB.
            </div>
          )}

          {/* Missing headers error */}
          {missingHeadersError && (
            <div
              role="alert"
              className="mt-3 rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300"
            >
              Missing required columns: word, gloss.
            </div>
          )}

          {/* Import result with row errors */}
          {hasResult && hasRowErrors && (
            <div className="mt-3">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {importResult!.inserted + importResult!.updated} word(s) imported ·{' '}
                {rowErrors.length} row(s) failed
              </p>
              <ul className="mt-2 space-y-1 text-sm text-red-700 dark:text-red-300 max-h-48 overflow-y-auto">
                {rowErrors.map((e) => (
                  <li key={e.row}>
                    Row {e.row}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={handleImport}
              disabled={!canImport}
              className="px-3 py-1.5 text-sm rounded-md bg-[color:var(--color-accent)] text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isImporting ? 'Importing…' : 'Import'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
