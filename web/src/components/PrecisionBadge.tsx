/**
 * Shared precision-badge primitives lifted out of TimelinePinSection so the
 * Phase 20 PinPopover can render the same precision dot + label treatment
 * without redeclaring the helpers (CONTEXT.md §D-13, PATTERNS.md §"Precision
 * Dot Visual").
 *
 * Visual contract (matches research §17 question 3):
 *   era         → accent (violet)
 *   approximate → neutral-400 (mid grey)
 *   exact       → neutral-200 (light grey)
 *
 * The exported `Precision` union mirrors the inline literal type used by
 * TimelinePin and PinEditor — keeping it as a named export here avoids
 * importing it from the hooks layer.
 */

export type Precision = 'exact' | 'approximate' | 'era';

/**
 * Tailwind classes for the small precision dot on the pin display.
 */
export function precisionDotClass(p: Precision): string {
  const base = 'inline-block w-2 h-2 rounded-full';
  switch (p) {
    case 'era':
      return `${base} bg-[color:var(--color-accent)]`;
    case 'approximate':
      return `${base} bg-neutral-400`;
    case 'exact':
    default:
      return `${base} bg-neutral-200 dark:bg-neutral-300`;
  }
}

export function PrecisionBadge({ precision }: { precision: Precision }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={precisionDotClass(precision)} />
      <span className="text-xs text-neutral-500">{precision}</span>
    </span>
  );
}
