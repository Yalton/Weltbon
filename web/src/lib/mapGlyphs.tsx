/**
 * Map glyph set and color palette.
 *
 * Provides:
 *  - MAP_GLYPHS: a Record of curated 24×24 SVG path strings for map-pin icons (D-02).
 *    Path strings contain the raw <path d="..."> data only; rendered via dangerouslySetInnerHTML
 *    inside a sandboxed <svg>. All values are hard-coded constants (T-40-10: never user input).
 *  - MAP_GLYPH_KEYS: string[] of all glyph keys.
 *  - getGlyphPath(key): returns the path string or null for unknown keys.
 *  - GlyphIcon: a React component that renders a named glyph inline.
 *  - MAP_COLOR_PALETTE: constrained hex array derived from ENTRY_TYPE_HEX + linkTypeColor
 *    preset hues — no arbitrary free hex (D-01).
 */

// ─── Glyph set ────────────────────────────────────────────────────────────────
// 11 curated 24×24 viewBox path strings (D-02: inline SVG, no icon library).
// T-40-10: all values are hard-coded constants; never accept user input here.

export const MAP_GLYPHS: Record<string, string> = {
  // 5-pointed star — capital city, key location
  star: '<path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>',

  // Medieval keep / tower — fortification
  keep: '<path d="M5 22V10h2V8H5V4h3V2h1v2h1V2h1v2h1V2h1v2h3v4h-2v2h2v12H5zm2-2h10v-8H7v8zm1-10h8V9H8v1zm0-2h2V5H8v3zm4 0h2V5h-2v3zm-1 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>',

  // Skull — danger zone, battlefield
  skull: '<path d="M12 2a7 7 0 0 1 7 7c0 2.6-1.4 4.8-3.5 6.1l-.5.3V17H9v-1.6l-.5-.3A7 7 0 0 1 12 2zm-2 14h4v1H10v-1zm1 2h2v2h-2v-2zm-3-9h2v2H8V9zm6 0h2v2h-2V9z"/>',

  // Crossed swords — battle site, conflict
  'crossed-swords': '<path d="M14.5 2.5l7 7-1.5 1.5-1-.9-5.1 5.1 1 1-1.4 1.4-1-1-2 2 .9 1-1.4 1.4-.9-1-1.6 1.6-1.4-1.4 1.6-1.6-1-1L8 16.6l-1 1-1.4-1.4 1-1-5.1-5.1-.9 1L1.1 9.6l7-7 1.5 1.5-1 1 5.1 5.1 2.7-2.7-1-1zM12 13l1 1-1.5 1.5-1-1L12 13z"/>',

  // Mountain peak — mountain range, highland
  mountain: '<path d="M14 6l-1-2H9L7 7l-5 9 1.5 1h17L22 16l-5-9-3-1zm-2 0l2.5 1H9.5L12 6zm-5.8 9L12 7.2 17.8 15H6.2z"/>',

  // Tree — forest, wilderness, nature
  tree: '<path d="M12 2l5 7h-3.5l3.5 5H14l2 4h-4v2h-4v-2H4l2-4H2.5l3.5-5H2.5L8 2h4z"/>',

  // Anchor — port, harbor, naval base
  anchor: '<path d="M12 2a3 3 0 0 1 3 3 3 3 0 0 1-2 2.8V9h3v2h-3v7.9a8 8 0 0 0 5-7.9h2a10 10 0 0 1-7 9.5V20h-2v-.5A10 10 0 0 1 4 10h2a8 8 0 0 0 5 7.9V11H8V9h3V7.8A3 3 0 0 1 9 5a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1z"/>',

  // Crown — kingdom, royalty, seat of power
  crown: '<path d="M3 18h18v2H3v-2zM2 7l4 8h1l3-5 3 5h1l4-8-2-.6-2.8 5.8-3-5.2h-1l-3 5.2L5 7.4 2 7z"/>',

  // City / town — settlement, major city
  city: '<path d="M15 2v5h-2V5H11v2H9V2H3v20h18V2h-6zm-2 18H5V12h8v8zm6 0h-4v-4h-2v4h-2v-6H7v6H5v-8h8v-4h4v-2h2v14z"/>',

  // Ruin — ancient site, destroyed city
  ruin: '<path d="M2 20h2v-3h2v3h3v-5h2v5h3v-7h2v7h3v-3h2v5H2v-2zm3-8l4-8 4 8H5zm2.8-2h2.4L9 7.3 7.8 10zm6.2 0l4-8 4 8h-8zm2.8-2h2.4L18 7.3l-1.2 2.7z"/>',

  // Fort — fortified outpost, military installation
  fort: '<path d="M3 3v18h18V3H3zm2 2h2v2H5V5zm4 0h2v2H9V5zm4 0h2v2h-2V5zm4 0h2v2h-2V5zM5 9h14v10H5V9zm2 2v6h4v-6H7zm6 0v6h4v-6h-4z"/>',
};

/** All available glyph key strings. */
export const MAP_GLYPH_KEYS: string[] = Object.keys(MAP_GLYPHS);

/**
 * Returns the SVG path string for a glyph key, or null for unknown keys.
 * T-40-10: output is always a hard-coded constant, never user input.
 */
export function getGlyphPath(key: string): string | null {
  return MAP_GLYPHS[key] ?? null;
}

// ─── GlyphIcon ────────────────────────────────────────────────────────────────

interface GlyphIconProps {
  glyph: string;
  size?: number;
  color?: string;
}

/**
 * Renders a named map glyph as an inline SVG.
 *
 * T-40-10: The path string is sourced exclusively from MAP_GLYPHS (hard-coded
 * constants). dangerouslySetInnerHTML is safe because no user input ever flows
 * into the path data.
 *
 * Returns null for unknown glyph keys so callers can safely call without
 * checking the key first.
 */
export function GlyphIcon({ glyph, size = 16, color = 'currentColor' }: GlyphIconProps): JSX.Element | null {
  const path = getGlyphPath(glyph);
  if (!path) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      aria-hidden="true"
      focusable="false"
    >
      {/* T-40-10: path is always a constant from MAP_GLYPHS, never user input */}
      <g dangerouslySetInnerHTML={{ __html: path }} />
    </svg>
  );
}

// ─── Constrained color palette ────────────────────────────────────────────────
// Sourced from ENTRY_TYPE_HEX + PRESET_LINK_TYPES preset hues (D-01).
// These are the canonical color choices for pins and regions — no arbitrary
// free hex is accepted via the UI; the picker shows only these swatches.

export const MAP_COLOR_PALETTE: string[] = [
  // Entry-type hex colors (from entryTypeColor.ts ENTRY_TYPE_HEX)
  '#3b82f6', // blue-500   — concept
  '#10b981', // emerald-500 — entity
  '#f59e0b', // amber-500  — location
  '#f43f5e', // rose-500   — event
  '#a855f7', // purple-500 — faction
  '#f97316', // orange-500 — artifact
  '#14b8a6', // teal-500   — species
  '#ec4899', // pink-500   — culture
  '#06b6d4', // cyan-500   — thread
  // Extra hues from linkTypeColor.ts PRESET_LINK_TYPES
  '#22c55e', // green-500  — located_in / ally-of group
  '#ef4444', // red-500    — enemy / danger
  '#78716c', // stone-500  — neutral / created_by
  '#6b7280', // neutral-500 — fallback / untyped
];
