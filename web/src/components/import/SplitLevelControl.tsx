
interface SplitLevelControlProps {
  detected: number | null;
  applied: number | null;
  counts: Record<string, number>;
  onChange: (level: number | null) => void;
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
        // outcome (SP-05). Say why the control is empty rather than rendering
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
