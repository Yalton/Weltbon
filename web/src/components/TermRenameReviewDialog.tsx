import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  dialogOverlayClasses,
  dialogContentClasses,
  dialogTitleClasses,
} from './ui/overlay';
import { Button } from './ui/Button';
import type { TermRenamePreview } from '../hooks/useDictionary';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preview: TermRenamePreview | null;
  isSaving?: boolean;
  /** Confirm with the entry ids the user left checked. */
  onConfirm: (entryIds: string[]) => void | Promise<void>;
  /** Rename the glossary row and leave every body alone. */
  onRenameOnly: () => void | Promise<void>;
}

const REASON_COPY: Record<TermRenamePreview['skipped'][number]['reason'], string> = {
  // Phrased as what the user would want to know, not as the internal rule.
  out_of_scope: 'uses this spelling in another language’s scope',
  case_mismatch: 'spells it with different capitalisation',
};

/**
 * Issue #59 — review which entries a dictionary-term rename rewrites.
 *
 * Every affected entry starts checked, because the user asked for the rename
 * and the common case is "all of them". What the dialog exists for is the
 * uncommon case: unchecking a note, and seeing the occurrences the rename will
 * NOT touch, before anything is written. Corpus rewrites are not undoable from
 * this screen, so the counts are shown per entry rather than as one total.
 */
export function TermRenameReviewDialog({
  open,
  onOpenChange,
  preview,
  isSaving = false,
  onConfirm,
  onRenameOnly,
}: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && preview) {
      setSelected(new Set(preview.entries.map((e) => e.entryId)));
    }
  }, [open, preview]);

  if (!preview) return null;

  function toggle(entryId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  const selectedCount = preview.entries
    .filter((e) => selected.has(e.entryId))
    .reduce((n, e) => n + e.wikilinkCount + e.textCount, 0);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClasses} />
        <Dialog.Content className={`${dialogContentClasses} max-w-lg`}>
          <Dialog.Title className={dialogTitleClasses}>
            Rename references to “{preview.word}”?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-secondary">
            {preview.totalOccurrences} reference
            {preview.totalOccurrences === 1 ? '' : 's'} across {preview.entries.length} entr
            {preview.entries.length === 1 ? 'y' : 'ies'} would become “{preview.newWord}”.
          </Dialog.Description>

          <ul className="mt-4 max-h-64 overflow-y-auto border border-neutral-200 dark:border-neutral-800 rounded-md divide-y divide-neutral-100 dark:divide-neutral-800">
            {preview.entries.map((e) => (
              <li key={e.entryId} className="px-3 py-2">
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(e.entryId)}
                    onChange={() => toggle(e.entryId)}
                    disabled={isSaving}
                    aria-label={`Rewrite ${e.title}`}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-semibold">{e.title}</span>
                    <span className="block text-ink-secondary">
                      {e.wikilinkCount} link{e.wikilinkCount === 1 ? '' : 's'},{' '}
                      {e.textCount} in text
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {preview.skipped.length > 0 && (
            <div className="mt-4 text-sm">
              <p className="text-ink-secondary">Left unchanged:</p>
              <ul className="mt-1 list-disc pl-5 text-ink-secondary">
                {preview.skipped.map((s) => (
                  <li key={`${s.entryId}-${s.reason}`}>
                    <span className="font-semibold">{s.title}</span> — {s.count} occurrence
                    {s.count === 1 ? '' : 's'} {REASON_COPY[s.reason]}.
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" disabled={isSaving}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button variant="ghost" onClick={onRenameOnly} disabled={isSaving}>
              Rename term only
            </Button>
            <Button
              variant="primary"
              onClick={() => onConfirm([...selected])}
              disabled={isSaving || selected.size === 0}
            >
              {isSaving
                ? 'Rewriting…'
                : `Rewrite ${selectedCount} reference${selectedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
