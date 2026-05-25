import type { AuditCategory } from '../hooks/useIssues';

/**
 * Emoji vocabulary per D-07. Literal unicode emoji in source so they render
 * everywhere without external font dependencies.
 *
 * underdeveloped     → 🌱 seedling (U+1F331)
 * missing-link       → 🔗 link     (U+1F517)
 * contradiction      → ⚠️ warning  (U+26A0 U+FE0F)
 * timeline-inconsistency → ⏱️ stopwatch (U+23F1 U+FE0F)
 * dangling-thread    → 🧵 thread   (U+1F9F5)
 */
export const EMOJI: Record<AuditCategory, string> = {
  'underdeveloped': '🌱',
  'missing-link': '🔗',
  'contradiction': '⚠️',
  'timeline-inconsistency': '⏱️',
  'dangling-thread': '🧵',
};

/**
 * Category-derived left-edge stripe classes per D-08.
 * MUST be written as full literal strings (no concatenation) so Tailwind's
 * JIT content scanner includes them in the bundle (T-25-04-04).
 *
 * Apply as `border-l-2 ${CATEGORY_STRIPE[issue.category]}` on the <li> element.
 */
export const CATEGORY_STRIPE: Record<AuditCategory, string> = {
  'contradiction': 'border-l-red-400 dark:border-l-red-500',
  'missing-link': 'border-l-blue-400 dark:border-l-blue-500',
  'underdeveloped': 'border-l-emerald-400 dark:border-l-emerald-500',
  'timeline-inconsistency': 'border-l-amber-400 dark:border-l-amber-500',
  'dangling-thread': 'border-l-violet-400 dark:border-l-violet-500',
};

/**
 * Renders the emoji for the given AuditCategory per D-07.
 * Unknown or undefined category falls back to a bullet '•'.
 */
export function CategoryIcon({ category }: { category: AuditCategory | string | undefined }) {
  const emoji = (category && EMOJI[category as AuditCategory]) ?? '•';
  const label = category ?? 'unknown';
  return (
    <span aria-label={label} role="img">
      {emoji}
    </span>
  );
}
