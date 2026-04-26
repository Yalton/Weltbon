/**
 * Pin shape consumed by groupByEra and the timeline UI.
 * Matches Plan 02's GET /timeline response shape (joined fields are optional
 * pass-through; groupByEra only reads `precision`).
 */
export interface TimelinePin {
  id: string;
  entryId: string;
  label: string;
  position: number;
  precision: 'exact' | 'approximate' | 'era';
  // Joined fields (callers may pass through; algorithm ignores)
  entryTitle?: string;
  entryIcon?: string;
  entryType?: string;
}

export interface Group {
  /** null = the implicit "before any era header" group */
  era: TimelinePin | null;
  pins: TimelinePin[];
}

/**
 * Groups a sorted list of pins so that 'era' precision pins become section
 * headers and subsequent non-era pins are placed under the most recent era.
 *
 * The input MUST be sorted ASC by position; this function does NOT re-sort.
 *
 * Edge cases:
 *  - Empty input → [{ era: null, pins: [] }] (caller renders empty state)
 *  - All-era input → each era is its own group with pins: []
 *  - All-non-era input → single group { era: null, pins: [...] }
 *  - Era then events → events grouped under the era
 *  - Multiple back-to-back era pins → each era is its own group, pins: []
 *  - Pins before any era → first group has era: null and those pins
 */
export function groupByEra(sorted: TimelinePin[]): Group[] {
  const groups: Group[] = [];
  let current: Group = { era: null, pins: [] };
  for (const p of sorted) {
    if (p.precision === 'era') {
      // Flush current group if it has any content (era or pins)
      if (current.era !== null || current.pins.length > 0) {
        groups.push(current);
      }
      current = { era: p, pins: [] };
    } else {
      current.pins.push(p);
    }
  }
  groups.push(current);
  return groups;
}
