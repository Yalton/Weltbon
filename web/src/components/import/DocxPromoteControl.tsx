import type { DocxFileInfo } from '../../types/ingestReview';

/**
 * Unstyled-heading promotion control for the import-review screen
 * (issue #35, DOCX-09).
 *
 * Shown above the entry list when the preview reports at least one .docx
 * part whose deterministic pass found NO headings but whose heuristic pass
 * WOULD find some (`unstyledCandidates > 0`) and that part has not already
 * been promoted. Promotion is opt-in (DOCX-09): the default import is
 * deterministic and predictable, and this control is the only way to ask
 * for the heuristic pass instead.
 *
 * The eligibility check is deliberately just `unstyledCandidates > 0`.
 * `unstyledCandidates` already arrives POST-GATE — the server reports 0
 * whenever styled headings exist, because promotion is refused in that case
 * (DOCX-09) and a control that promotes but no unstyled candidate documents
 * exist would provably do nothing. Re-deriving that gate here (e.g.
 * `styled === 0 && unstyledCandidates > 0`) would duplicate a rule that
 * lives on the server and can drift from it.
 *
 * Presentational + prop-driven; the parent owns the re-request, exactly as
 * SplitLevelControl does for `split_level`.
 */

interface DocxPromoteControlProps {
  files: DocxFileInfo[];
  onPromote: () => void;
  /** True while a re-preview is in flight, so a double click cannot race two requests. */
  disabled?: boolean;
}

/**
 * Total unstyled-heading candidates across .docx parts that are eligible for
 * promotion (not already promoted). Exported so the "should this control
 * render at all" decision and its N-count are computed by one function
 * rather than duplicated between a render guard and the label.
 */
export function eligibleUnstyledCandidateCount(files: DocxFileInfo[]): number {
  return files
    .filter((f) => !f.headings.promoted)
    .reduce((sum, f) => sum + f.headings.unstyledCandidates, 0);
}

export function DocxPromoteControl({
  files,
  onPromote,
  disabled = false,
}: DocxPromoteControlProps) {
  const total = eligibleUnstyledCandidateCount(files);
  if (total <= 0) return null;

  return (
    <section
      aria-label="Unstyled heading promotion"
      className="border-b border-neutral-200 dark:border-neutral-800 px-4 py-3"
    >
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-2">
        One or more Word documents have no styled headings, but look like
        they have hand-formatted ones.
      </p>
      <button
        type="button"
        disabled={disabled}
        onClick={onPromote}
        className="text-sm px-2 py-1 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Treat {total} bold paragraph{total === 1 ? '' : 's'} as headings
      </button>
    </section>
  );
}
