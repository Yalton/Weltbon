import type { DocxFileInfo } from '../../types/ingestReview';


interface DocxPromoteControlProps {
  files: DocxFileInfo[];
  onChange: (uploadIndex: number, promoted: boolean) => void;
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
