import type { DocxFileInfo } from '../../types/ingestReview';

/**
 * Unstyled-heading promotion control for the import-review screen
 * (issue #35, DOCX-09).
 *
 * Shown above the entry list when the preview reports at least one .docx
 * part whose heuristic pass found candidates (`unstyledCandidates > 0`).
 * Each eligible upload has its own reversible control because names are not
 * unique and the server identifies uploads by their stable multipart index.
 *
 * The eligibility check is deliberately just `unstyledCandidates > 0`.
 * That count already reflects the server's eligibility rule: it can be
 * positive for either a zero-styled document or an eligible mixed document,
 * and is zero below the mixed ratio-or-absolute threshold. Re-deriving the
 * rule here would duplicate server policy and can drift from it.
 *
 * Presentational + prop-driven; the parent owns the re-request, exactly as
 * SplitLevelControl does for `split_level`.
 */

interface DocxPromoteControlProps {
  files: DocxFileInfo[];
  onChange: (uploadIndex: number, promoted: boolean) => void;
  /** True while a re-preview is in flight, so a double click cannot race two requests. */
  disabled?: boolean;
}

export function DocxPromoteControl({
  files,
  onChange,
  disabled = false,
}: DocxPromoteControlProps) {
  const eligibleFiles = files.filter(
    (file) => file.headings.unstyledCandidates > 0,
  );
  if (eligibleFiles.length === 0) return null;

  return (
    <section
      aria-label="Unstyled heading promotion"
      className="border-b border-neutral-200 dark:border-neutral-800 px-4 py-3"
    >
      <div className="space-y-3">
        {eligibleFiles.map((file) => {
          const { styled, unstyledCandidates, promoted } = file.headings;
          return (
            <div key={file.uploadIndex} className="space-y-1">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {styled > 0
                  ? 'Styled headings remain; choose whether to also use hand-formatted paragraphs.'
                  : 'This document has no styled headings but has hand-formatted candidates.'}
              </p>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(file.uploadIndex, !promoted)}
                className="text-sm px-2 py-1 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {file.path}: {promoted ? (
                  'Use styled headings only.'
                ) : (
                  <>
                    Treat {unstyledCandidates} bold paragraph
                    {unstyledCandidates === 1 ? '' : 's'} as headings
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
