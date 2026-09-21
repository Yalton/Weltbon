
export type LinkTypeRegistryEntry = {
  color?: string;
  directionDefault?: 'directed' | 'undirected';
  inverseLabel?: string;
};

export type LinkTypeRegistry = Record<string, LinkTypeRegistryEntry>;

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

export const NEUTRAL_EDGE_COLOR = '#6b7280';

export function getLinkTypeColor(
  linkType: string | null,
  registry: LinkTypeRegistry = {},
): string {
  if (!linkType) return NEUTRAL_EDGE_COLOR;
  if (registry[linkType]?.color) return registry[linkType].color!;
  if (PRESET_LINK_TYPES[linkType]) return PRESET_LINK_TYPES[linkType].color;
  return hashColor(linkType);
}

export function hashColor(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // convert to 32-bit int
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

export function getInverseLabel(
  linkType: string | null,
  registry: LinkTypeRegistry = {},
): string | null {
  if (!linkType) return null;
  if (registry[linkType]?.inverseLabel) return registry[linkType].inverseLabel!;
  if (PRESET_LINK_TYPES[linkType]?.inverseLabel) return PRESET_LINK_TYPES[linkType].inverseLabel!;
  return null;
}

export function formatLinkType(linkType: string): string {
  return linkType
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
