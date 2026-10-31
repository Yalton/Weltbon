import { useState } from 'react';
import { ConfirmDialog } from '../ConfirmDialog';
import { pluralize } from '../../lib/format';
import type { SavedDraft } from '../../types/ingestReview';

interface ImportResumePromptProps {
  draft: SavedDraft;
  onContinue: () => void;
  onDiscard: () => void;
}

export function ImportResumePrompt({
  draft,
  onContinue,
  onDiscard,
}: ImportResumePromptProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const entryCount = draft.preview.entries.length;
  const relative = formatRelativeFromIso(draft.savedAt);

  return (
    <div className="max-w-md mx-auto py-12 text-center">
      <h1 className="text-xl font-semibold tracking-tight">
        You have an in-progress import
      </h1>
      <p className="mt-2 text-sm text-ink-secondary leading-[1.5]">
        You started reviewing {pluralize(entryCount, 'entry', 'entries')} {relative}.
        Pick up where you left off, or start over with a fresh upload.
      </p>
      <div className="mt-6 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={onContinue}
          className="btn-accent text-sm px-3 py-1.5 rounded-md"
        >
          Continue review
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="text-sm px-3 py-1.5 rounded-md border border-line-strong"
        >
          Discard and start over
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Discard your import draft?"
        body={`This clears your in-progress review of ${pluralize(entryCount, 'entry', 'entries')}. The original Markdown files on your computer are untouched, but you'll have to re-upload and start over.`}
        confirmLabel="Discard draft"
        destructive
        onConfirm={onDiscard}
      />
    </div>
  );
}

function formatRelativeFromIso(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'recently';
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} ${day === 1 ? 'day' : 'days'} ago`;
  return new Date(iso).toLocaleDateString();
}
