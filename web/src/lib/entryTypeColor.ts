/**
 * Shared entry-type color palette.
 *
 * Centralises the type → color mapping used by TypeBadge (Tailwind classes
 * for the list/detail UI) and, in Plan 08, the graph view (hex colors for
 * SVG node fills). Keeping both flavors in one module means a single source
 * of truth whenever a new entry type is added.
 */

export const ENTRY_TYPE_NAMES = [
  'concept',
  'entity',
  'location',
  'event',
  'faction',
  'artifact',
  'species',
  'culture',
  'thread',
] as const;

const TYPE_CLASSES: Record<string, string> = {
  concept:
    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  entity:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  location:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  event:
    'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  faction:
    'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  artifact:
    'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  species:
    'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  culture:
    'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  thread:
    'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
};

const TYPE_CLASSES_FALLBACK =
  'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';

const ENTRY_TYPE_HEX: Record<string, string> = {
  concept: '#3b82f6', // blue-500
  entity: '#10b981', // emerald-500
  location: '#f59e0b', // amber-500
  event: '#f43f5e', // rose-500
  faction: '#a855f7', // purple-500
  artifact: '#f97316', // orange-500
  species: '#14b8a6', // teal-500
  culture: '#ec4899', // pink-500
  thread: '#06b6d4', // cyan-500
};

const ENTRY_TYPE_HEX_FALLBACK = '#6b7280'; // neutral-500

/**
 * Tailwind class string for a typed pill/badge. Case-insensitive; falls back
 * to a neutral gray when the type is unknown.
 */
export function entryTypeColor(type: string): string {
  return TYPE_CLASSES[type.toLowerCase()] ?? TYPE_CLASSES_FALLBACK;
}

/**
 * Hex color for SVG fills (used by the graph view). Case-insensitive; falls
 * back to neutral-500 when the type is unknown.
 */
export function entryTypeHexColor(type: string): string {
  return ENTRY_TYPE_HEX[type.toLowerCase()] ?? ENTRY_TYPE_HEX_FALLBACK;
}
