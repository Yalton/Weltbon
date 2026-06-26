/**
 * Map glyph set and color palette.
 *
 * Provides:
 *  - MAP_GLYPHS: a Record of curated 24×24 SVG path strings for map-pin icons (D-02).
 *    Path strings contain the raw <path d="..."> data only; rendered via dangerouslySetInnerHTML
 *    inside a sandboxed <svg>. All values are hard-coded constants (T-40-10: never user input).
 *  - MAP_GLYPH_KEYS: string[] of all glyph keys.
 *  - MAP_GLYPH_GROUPS: Record<string, string[]> — six themed groups for the picker (D-01).
 *  - getGlyphPath(key): returns the path string or null for unknown keys.
 *  - GlyphIcon: a React component that renders a named glyph inline.
 *  - MAP_COLOR_PALETTE: constrained hex array derived from ENTRY_TYPE_HEX + linkTypeColor
 *    preset hues — no arbitrary free hex (D-01).
 */

// ─── Glyph set ────────────────────────────────────────────────────────────────
// 32 curated 24×24 viewBox path strings (D-01, D-02: inline SVG, no icon library).
// T-40-10: all values are hard-coded constants; never accept user input here.

export const MAP_GLYPHS: Record<string, string> = {
  // ── Settlements ───────────────────────────────────────────────────────────

  // 5-pointed star — capital city, key location
  star: '<path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>',

  // Medieval keep / tower — fortification
  keep: '<path d="M5 22V10h2V8H5V4h3V2h1v2h1V2h1v2h1V2h1v2h3v4h-2v2h2v12H5zm2-2h10v-8H7v8zm1-10h8V9H8v1zm0-2h2V5H8v3zm4 0h2V5h-2v3zm-1 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>',

  // City / town — settlement, major city
  city: '<path d="M15 2v5h-2V5H11v2H9V2H3v20h18V2h-6zm-2 18H5V12h8v8zm6 0h-4v-4h-2v4h-2v-6H7v6H5v-8h8v-4h4v-2h2v14z"/>',

  // Ruin — ancient site, destroyed city
  ruin: '<path d="M2 20h2v-3h2v3h3v-5h2v5h3v-7h2v7h3v-3h2v5H2v-2zm3-8l4-8 4 8H5zm2.8-2h2.4L9 7.3 7.8 10zm6.2 0l4-8 4 8h-8zm2.8-2h2.4L18 7.3l-1.2 2.7z"/>',

  // Village — small settlement, hamlet
  village: '<path d="M2 22v-8l4-3 4 3v8H2zm2-2h4v-6l-2-1.5L4 14v6zm10 2v-6l4-3 4 3v6h-8zm2-2h4v-4l-2-1.5-2 1.5v4z"/>',

  // Inn — tavern, waystation, lodging
  inn: '<path d="M3 22V10l9-7 9 7v12H3zm2-2h14V11.2L12 5.5 5 11.2V20zm3-2v-4h8v4H8zm2-2h4v-2h-4v2z"/>',

  // Harbor — port, dock, coastal landing
  harbor: '<path d="M12 2a4 4 0 0 1 4 4H8a4 4 0 0 1 4-4zm-6 6h12v2H6V8zm1 4h10l-1 6H8l-1-6zm2 2v2h6v-2h-6zM3 20h18v2H3v-2z"/>',

  // ── Terrain ───────────────────────────────────────────────────────────────

  // Mountain peak — mountain range, highland
  mountain: '<path d="M14 6l-1-2H9L7 7l-5 9 1.5 1h17L22 16l-5-9-3-1zm-2 0l2.5 1H9.5L12 6zm-5.8 9L12 7.2 17.8 15H6.2z"/>',

  // Mountain pass — gap or route through peaks
  'mountain-pass': '<path d="M2 20l4-8 3 4 3-7 3 7 3-4 4 8H2zm3.5-4L8 20h2l-2-6-2.5 2zm10 0L13 14l-2 6h2l2.5-4zM12 6l-2 5h4l-2-5z"/>',

  // Cave — underground entrance, dungeon mouth
  cave: '<path d="M4 22v-8a8 8 0 0 1 16 0v8H4zm2-2h12v-6a6 6 0 0 0-12 0v6zm4 0h4v-4a2 2 0 0 0-4 0v4z"/>',

  // Volcano — active volcano, eruption site
  volcano: '<path d="M12 3l4 7h-2l2 4-6 8-6-8 2-4H4l4-7h4zm0 3L9.5 11h5L12 6zm-4.5 7L10 17h4l2.5-4h-9z"/>',

  // Desert — arid wasteland, sand sea
  desert: '<path d="M2 18c2-4 4-4 6 0s4 4 6 0 4-4 6 0v2c-2 4-4 4-6 0s-4-4-6 0-4 4-6 0v-2zm7-8l3-6 3 6H9zm1.5 0h3l-1.5-3-1.5 3z"/>',

  // ── Danger / War ─────────────────────────────────────────────────────────

  // Skull — danger zone, battlefield
  skull: '<path d="M12 2a7 7 0 0 1 7 7c0 2.6-1.4 4.8-3.5 6.1l-.5.3V17H9v-1.6l-.5-.3A7 7 0 0 1 12 2zm-2 14h4v1H10v-1zm1 2h2v2h-2v-2zm-3-9h2v2H8V9zm6 0h2v2h-2V9z"/>',

  // Crossed swords — battle site, conflict
  'crossed-swords': '<path d="M14.5 2.5l7 7-1.5 1.5-1-.9-5.1 5.1 1 1-1.4 1.4-1-1-2 2 .9 1-1.4 1.4-.9-1-1.6 1.6-1.4-1.4 1.6-1.6-1-1L8 16.6l-1 1-1.4-1.4 1-1-5.1-5.1-.9 1L1.1 9.6l7-7 1.5 1.5-1 1 5.1 5.1 2.7-2.7-1-1zM12 13l1 1-1.5 1.5-1-1L12 13z"/>',

  // Fort — fortified outpost, military installation
  fort: '<path d="M3 3v18h18V3H3zm2 2h2v2H5V5zm4 0h2v2H9V5zm4 0h2v2h-2V5zm4 0h2v2h-2V5zM5 9h14v10H5V9zm2 2v6h4v-6H7zm6 0v6h4v-6h-4z"/>',

  // Watchtower — lookout post, guard tower, beacon
  watchtower: '<path d="M9 22V10h6v12H9zm2-2h2v-8h-2v8zM6 10h12v2H6v-2zM8 8V4h8v4H8zm2-2h4V6h-4v2zM7 2h10v2H7V2z"/>',

  // Plague — disease, cursed area, quarantine
  plague: '<path d="M12 2a6 6 0 0 1 6 6c0 2.2-1.2 4.2-3 5.3V15H9v-1.7A6 6 0 0 1 6 8a6 6 0 0 1 6-6zm-2 14h4v1h-4v-1zm1 2h2v2h-2v-2zM4 3l2.5 2.5L4 8 2 6l2-3zm16 0l2 3-2 2-2.5-2.5L18 3z"/>',

  // ── Points of Interest ────────────────────────────────────────────────────

  // Anchor — port, harbor, naval base
  anchor: '<path d="M12 2a3 3 0 0 1 3 3 3 3 0 0 1-2 2.8V9h3v2h-3v7.9a8 8 0 0 0 5-7.9h2a10 10 0 0 1-7 9.5V20h-2v-.5A10 10 0 0 1 4 10h2a8 8 0 0 0 5 7.9V11H8V9h3V7.8A3 3 0 0 1 9 5a3 3 0 0 1 3-3zm0 2a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1z"/>',

  // Crown — kingdom, royalty, seat of power
  crown: '<path d="M3 18h18v2H3v-2zM2 7l4 8h1l3-5 3 5h1l4-8-2-.6-2.8 5.8-3-5.2h-1l-3 5.2L5 7.4 2 7z"/>',

  // Temple — place of worship, sacred building, oracle
  temple: '<path d="M2 20h20v2H2v-2zm2-1V9h3v10H4zm4 0V9h3v10H8zm4 0V9h3v10h-3zm4 0V9h3v10h-3zM2 8V6h20v2H2zm8-6h4l6 4H4l6-4z"/>',

  // Market — trading post, bazaar, commerce hub
  market: '<path d="M2 9V6h20v3H2zm2 1h4v10H4V10zm5 0h4v10H9V10zm5 0h4v10h-4V10zM4 6l2-4h12l2 4H4z"/>',

  // Library — archive, scriptorium, hall of records
  library: '<path d="M2 4h2v16H2V4zm3 0h2v16H5V4zm3 0h2v16H8V4zm4-2h8v20h-8V2zm2 2h4v2h-4V4zm0 4h4v2h-4V8zm0 4h4v2h-4v-2zm0 4h4v2h-4v-2z"/>',

  // Shrine — small holy site, roadside altar, spirit house
  shrine: '<path d="M9 22v-5h6v5H9zm2-2h2v-1h-2v1zM6 17v-2h12v2H6zM7 13v-2h10v2H7zm-2-4V6l7-4 7 4v3H5zm7-5L6 8h12l-6-4z"/>',

  // ── Nature ────────────────────────────────────────────────────────────────

  // Tree — forest, wilderness, nature
  tree: '<path d="M12 2l5 7h-3.5l3.5 5H14l2 4h-4v2h-4v-2H4l2-4H2.5l3.5-5H2.5L8 2h4z"/>',

  // Forest — dense woodland, old-growth timber
  forest: '<path d="M5 22v-4h2v-3l-3-6 4-7h4l4 7-3 6v3h2v4H5zm2-2h8v-2H7v2zm1-4h6v-3l3-5-3-5H10L7 13l3 5v3zM3 18l-1-2 3-5-2-5 3-4 1 1-2 3 2 5-3 5 1 2H3zm18-2l1-2-1-2 2-5-2-3 1-1 3 4-2 5 3 5-1 2h-3z"/>',

  // Lake — freshwater body, inland sea, reservoir
  lake: '<path d="M12 6a6 6 0 0 1 6 6 6 6 0 0 1-6 6 6 6 0 0 1-6-6 6 6 0 0 1 6-6zm0 2a4 4 0 0 0-4 4 4 4 0 0 0 4 4 4 4 0 0 0 4-4 4 4 0 0 0-4-4zM2 4c2 2 4 2 5 0s3-2 5 0 3 2 5 0l1 1.5c-2 2-4 2-5 0s-3-2-5 0-3 2-5 0L2 4zm0 14c2-2 4-2 5 0s3 2 5 0 3-2 5 0l1-1.5c-2-2-4-2-5 0s-3 2-5 0-3-2-5 0L2 18z"/>',

  // Swamp — marshland, fen, wetland
  swamp: '<path d="M6 22v-4l-3-3v-3h3V9l2-5h2l2 5v3h3v3l-3 3v4H6zm2-2h4v-3l3-3v-1h-3V9l-2-4-2 4v3H5v1l3 3v3zm10-8c1 1 2 1 3 0v2c-1 1-2 1-3 0v-2zm-16 0c1-1 2-1 3 0v2c-1 1-2 1-3 0v-2z"/>',

  // Flower — garden, meadow, bloom, sacred grove
  flower: '<path d="M12 10a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2zm0-8c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm0 16c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm8-8c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-16 0c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm13.7-5.7c.8.8.8 2 0 2.8-.8.8-2 .8-2.8 0-.8-.8-.8-2 0-2.8.8-.8 2-.8 2.8 0zm-11.4 0c.8-.8 2-.8 2.8 0 .8.8.8 2 0 2.8-.8.8-2 .8-2.8 0-.8-.8-.8-2 0-2.8zm0 11.4c-.8-.8-.8-2 0-2.8.8-.8 2-.8 2.8 0 .8.8.8 2 0 2.8-.8.8-2 .8-2.8 0zm11.4 0c-.8.8-2 .8-2.8 0-.8-.8-.8-2 0-2.8.8-.8 2-.8 2.8 0 .8.8.8 2 0 2.8z"/>',

  // ── Mystical ─────────────────────────────────────────────────────────────

  // Eye — all-seeing eye, oracle, divination, scrying
  eye: '<path d="M12 5C6 5 1 12 1 12s5 7 11 7 11-7 11-7S18 5 12 5zm0 12a5 5 0 0 1-5-5 5 5 0 0 1 5-5 5 5 0 0 1 5 5 5 5 0 0 1-5 5zm0-8a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>',

  // Crystal — gem, arcane focus, magical resource node
  crystal: '<path d="M12 2l3 5-3 15-3-15 3-5zm-3 5L6 9l6 13V7H9zm6 0h-3v15l6-13-3-2zM4 8l4-2-4 14V8zm16 0v12l-4-14 4 2z"/>',

  // Portal — gateway, rift, planar nexus
  portal: '<path d="M12 2a10 10 0 0 1 10 10 10 10 0 0 1-10 10A10 10 0 0 1 2 12 10 10 0 0 1 12 2zm0 2a8 8 0 0 0-8 8 8 8 0 0 0 8 8 8 8 0 0 0 8-8 8 8 0 0 0-8-8zm0 3a5 5 0 0 1 5 5 5 5 0 0 1-5 5 5 5 0 0 1-5-5 5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>',
};

/** All available glyph key strings. */
export const MAP_GLYPH_KEYS: string[] = Object.keys(MAP_GLYPHS);

/**
 * Themed grouping of glyph keys for the pin icon picker (D-01).
 *
 * Six theme groups: settlements, terrain, danger-war, poi, nature, mystical.
 * Every key in every group is present in MAP_GLYPHS. The flat MAP_GLYPHS record
 * is NOT restructured — group membership is expressed here separately so
 * getGlyphPath/GlyphIcon lookups and the pin-style {color, icon} contract remain unchanged.
 *
 * T-40-10: all keys are hard-coded string literals.
 */
export const MAP_GLYPH_GROUPS: Record<string, string[]> = {
  settlements:  ['city', 'keep', 'fort', 'ruin', 'village', 'inn', 'harbor'],
  terrain:      ['mountain', 'mountain-pass', 'cave', 'volcano', 'desert', 'lake'],
  'danger-war': ['skull', 'crossed-swords', 'watchtower', 'plague'],
  poi:          ['anchor', 'crown', 'temple', 'market', 'library', 'shrine'],
  nature:       ['tree', 'forest', 'swamp', 'flower'],
  mystical:     ['star', 'eye', 'crystal', 'portal'],
};

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
export function GlyphIcon({ glyph, size = 16, color = 'currentColor' }: GlyphIconProps) {
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
