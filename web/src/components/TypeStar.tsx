import { entryTypeHexColor } from '../lib/entryTypeColor';

/** The star outline in a 10x10 box, shared with the SVG medallion badge. */
export const TYPE_STAR_PATH =
  'M5 0 C5.4 3.2 6.8 4.6 10 5 C6.8 5.4 5.4 6.8 5 10 C4.6 6.8 3.2 5.4 0 5 C3.2 4.6 4.6 3.2 5 0 Z';

/**
 * The type star: a four-point star in the entry type's colour. It is the one
 * mark that carries type everywhere an entry appears (rows, links, graph nodes,
 * timeline pins), so the type hues stay the only saturated colour in the app.
 * Decorative: pair it with the type name in text.
 */
export function TypeStar({ type, size = 10 }: { type: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0"
      style={{ color: entryTypeHexColor(type) }}
    >
      <path
        d={TYPE_STAR_PATH}
        fill="currentColor"
      />
    </svg>
  );
}
