/**
 * Split-level control for the import-review screen (issue #37, SP-04).
 *
 * Shown above the entry list when a batch is a SINGLE structured Markdown
 * document, which is the only shape eligible for splitting (SP-01). The
 * document has already been split by the time this renders — auto-detection
 * runs server-side and the preview below reflects it. This control exists so
 * the user can AUDIT that guess and correct it.
 *
 * Why every level carries its entry count: the count is what makes the guess
 * checkable at a glance ("H2 (11 entries)" against a document the user knows
 * has eleven sections), which is what #37's "the split rule is selected or
 * confirmed in preview" asks for. A bare level picker would make the user
 * re-run the preview to discover what each choice means.
 *
 * "Don't split" is ALWAYS offered, so auto-detection can never trap a user
 * into a split they did not want (SP-04).
 *
 * Presentational + prop-driven; the parent owns the level state and re-requests
 * the preview on change. Static Tailwind class strings only.
 */

interface SplitLevelControlProps {
  /** What the server auto-detected, or null when no heading level repeats. */
  detected: number | null;
  /** What THIS preview actually used. Diverges from `detected` on an override. */
  applied: number | null;
  /** Level -> entry count, e.g. `{"1": 3, "2": 11}`. Keys are strings on the wire. */
  counts: Record<string, number>;
  onChange: (level: number | null) => void;
  /** True while a re-preview is in flight, so a double click cannot race two requests. */
  disabled?: boolean;
}

const OPTION_CLASSES =
  'text-sm px-2 py-1 rounded border border-neutral-200 dark:border-neutral-800 ' +
  'hover:bg-neutral-100 dark:hover:bg-neutral-800 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed ' +
  'aria-pressed:border-[color:var(--color-accent)]';

export function SplitLevelControl({
  detected,
  applied,
  counts,
  onChange,
  disabled = false,
}: SplitLevelControlProps) {
  // Wire keys are strings; sort numerically so H10-style ordering never bites.
  const levels = Object.keys(counts)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 6)
    .sort((a, b) => a - b);

  return (
    <section
      aria-label="Split level"
      className="border-b border-neutral-200 dark:border-neutral-800 px-4 py-3"
    >
      <h3 className="text-xs uppercase tracking-wide font-medium text-neutral-500 mb-2">
        Split at
      </h3>

      {levels.length === 0 ? (
        // Not an error state — a document with nothing that repeats is a valid
        // outcome (SP-05). Say why the control is empty rather than rendering
        // a row of nothing and leaving the user to guess.
        <p className="text-sm text-neutral-500">
          This document has no repeated headings, so there is nothing to split on. It will
          import as one entry.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={applied === level}
              disabled={disabled}
              onClick={() => onChange(level)}
              className={OPTION_CLASSES}
            >
              H{level} ({counts[String(level)]} entries)
              {detected === level && (
                <span className="ml-1 text-xs text-neutral-500">detected</span>
              )}
            </button>
          ))}

          <button
            type="button"
            aria-pressed={applied === null}
            disabled={disabled}
            onClick={() => onChange(null)}
            className={OPTION_CLASSES}
          >
            Don't split (1 entry)
          </button>
        </div>
      )}
    </section>
  );
}
