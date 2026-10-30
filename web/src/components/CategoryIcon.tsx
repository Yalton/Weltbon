import type { AuditCategory } from '../hooks/useIssues';

export const CATEGORY_LABEL: Record<AuditCategory, string> = {
  'underdeveloped': 'Underdeveloped',
  'missing-link': 'Missing link',
  'contradiction': 'Contradiction',
  'timeline-inconsistency': 'Timeline inconsistency',
  'dangling-thread': 'Dangling thread',
};

// 16x16 stroke paths in the style of the sidebar's NavIcon.
const GLYPH_PATHS = {
  'underdeveloped': 'M8 14V8m0 0C8 5 6 3.5 3 3.5 3 6.5 5 8 8 8zm0 0c0-2.5 1.7-4 4.5-4 0 2.7-1.8 4-4.5 4z',
  'missing-link': 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  'contradiction': 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.5v.01',
  'timeline-inconsistency': 'M8 4.5V8l2.5 1.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z',
  'dangling-thread': 'M3 4c3 0 3 3 5 3s2-3 5-3M8 7v4.5a1.5 1.5 0 1 1-1.5 1.5',
  'unknown': 'M8 8v.01',
  'check': 'M3 8.5l3 3 7-7',
  'warning': 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.5v.01',
  'cross': 'M4 4l8 8M12 4l-8 8',
  'scale': 'M8 2.5v11M5 13.5h6M3 5h10M3 5l-1.5 4a1.5 1.5 0 0 0 3 0zm10 0l-1.5 4a1.5 1.5 0 0 0 3 0z',
  'plus': 'M8 3.5v9M3.5 8h9',
  'chevron-down': 'M4.5 6.5L8 10l3.5-3.5',
} as const;

export type GlyphName = keyof typeof GLYPH_PATHS;

/** Decorative icon. Always pair it with visible text; it is hidden from screen readers. */
export function Glyph({ name, className = '' }: { name: GlyphName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`inline-block shrink-0 align-[-2px] ${className}`}
    >
      <path d={GLYPH_PATHS[name]} />
    </svg>
  );
}

function isCategory(category: string | undefined): category is AuditCategory {
  return category !== undefined && category in CATEGORY_LABEL;
}

export function CategoryIcon({
  category,
  withLabel = false,
}: {
  category: AuditCategory | string | undefined;
  /** Show the category name beside the icon. Leave off only where the name is already visible. */
  withLabel?: boolean;
}) {
  const known = isCategory(category);
  const glyph = <Glyph name={known ? category : 'unknown'} />;
  if (!withLabel) return glyph;
  return (
    <span className="inline-flex items-center gap-1">
      {glyph}
      {known ? CATEGORY_LABEL[category] : (category ?? 'Unknown')}
    </span>
  );
}
