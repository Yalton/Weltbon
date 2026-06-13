/**
 * Link-type color palette and utility functions.
 *
 * Provides the curated preset vocabulary (PRESET_LINK_TYPES), a neutral
 * fallback (NEUTRAL_EDGE_COLOR), and pure functions for mapping link types
 * to display colors (getLinkTypeColor), deriving inverse labels
 * (getInverseLabel), formatting type strings (formatLinkType), and hashing
 * custom type strings to a deterministic HSL color (hashColor).
 *
 * Consumed by:
 *  - Graph canvas edge coloring (Plan 28-04)
 *  - LinkTypeSelect combobox swatches (Plan 28-03)
 *  - LinkSection group headings (Plan 28-03)
 *  - RelationLegend panel (Plan 28-04)
 */

export type LinkTypeRegistryEntry = {
  color?: string;
  directionDefault?: 'directed' | 'undirected';
  inverseLabel?: string;
};

export type LinkTypeRegistry = Record<string, LinkTypeRegistryEntry>;

/**
 * Curated preset link types with locked hex colors (UI-SPEC §"Link-Type
 * Curated Palette"), direction defaults, and inverse labels where applicable.
 *
 * LOCKED — do NOT change hex values; they are the UI-SPEC data-encoding colors.
 */
export const PRESET_LINK_TYPES: Record<
  string,
  {
    color: string;
    direction: 'directed' | 'undirected';
    inverseLabel?: string;
  }
> = {
  parent_of:  { color: '#3b82f6', direction: 'directed',   inverseLabel: 'child_of'   },
  child_of:   { color: '#3b82f6', direction: 'directed',   inverseLabel: 'parent_of'  },
  spouse_of:  { color: '#ec4899', direction: 'undirected'                              },
  sibling_of: { color: '#a855f7', direction: 'undirected'                              },
  member_of:  { color: '#f97316', direction: 'directed',   inverseLabel: 'has_member' },
  located_in: { color: '#22c55e', direction: 'directed',   inverseLabel: 'contains'   },
  ally_of:    { color: '#06b6d4', direction: 'undirected'                              },
  enemy_of:   { color: '#ef4444', direction: 'undirected'                              },
  created_by: { color: '#78716c', direction: 'directed',   inverseLabel: 'owns'       },
  owns:       { color: '#d97706', direction: 'directed',   inverseLabel: 'created_by' },
  related_to: { color: '#94a3b8', direction: 'undirected'                              },
};

/**
 * Fallback stroke color for untyped links.
 * Matches the existing hardcoded value at GraphCanvas.tsx:165.
 */
export const NEUTRAL_EDGE_COLOR = '#6b7280';

/**
 * Map a link type string to its display color.
 *
 * Priority:
 * 1. Registry override (user-customized color for this universe)
 * 2. Preset palette (curated colors from UI-SPEC)
 * 3. Deterministic hash (djb2 → HSL)
 * 4. NEUTRAL_EDGE_COLOR (null / empty type = untyped)
 */
export function getLinkTypeColor(
  linkType: string | null,
  registry: LinkTypeRegistry = {},
): string {
  if (!linkType) return NEUTRAL_EDGE_COLOR;
  if (registry[linkType]?.color) return registry[linkType].color!;
  if (PRESET_LINK_TYPES[linkType]) return PRESET_LINK_TYPES[linkType].color;
  return hashColor(linkType);
}

/**
 * Deterministic djb2 hash → hsl({hue}, 60%, 55%) color for custom link types.
 * Same hue for same string across calls and sessions.
 */
export function hashColor(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // convert to 32-bit int
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

/**
 * Derive the inverse label for a link type.
 *
 * Priority:
 * 1. Registry-level inverseLabel override
 * 2. PRESET_LINK_TYPES inverseLabel
 * 3. null (custom types have no implicit inverse)
 */
export function getInverseLabel(
  linkType: string | null,
  registry: LinkTypeRegistry = {},
): string | null {
  if (!linkType) return null;
  if (registry[linkType]?.inverseLabel) return registry[linkType].inverseLabel!;
  if (PRESET_LINK_TYPES[linkType]?.inverseLabel) return PRESET_LINK_TYPES[linkType].inverseLabel!;
  return null;
}

/**
 * Format a link_type string for human display.
 * Replaces underscores with spaces and title-cases each word.
 *
 * e.g. 'parent_of' → 'Parent Of', 'related_to' → 'Related To'
 */
export function formatLinkType(linkType: string): string {
  return linkType
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
