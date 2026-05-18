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

/**
 * An era's inferred span on the parallax band layer (Phase 20 D-04).
 *
 * `startPos` is the era pin's own position; `endPos` is the next era pin's
 * position, or `windowEnd` for the last era. Renderers translate these to
 * canvas x-coordinates via `posToX` from `timelineMath.ts`.
 */
export interface EraSpan {
  era: TimelinePin;
  startPos: number;
  endPos: number;
}

/**
 * Infer era spans for the parallax band layer (Phase 20 D-04).
 *
 * Filters `sorted` to era pins (`precision === 'era'`), then maps each era
 * to a span running from its own position to the next era's position (or
 * `windowEnd` for the last era). Non-era pins are ignored.
 *
 * Input MUST be sorted ASC by position (callers' responsibility, same
 * contract as `groupByEra`). The function does not re-sort.
 *
 * Edge cases:
 *  - Empty input → []
 *  - No era pins → []
 *  - Single era → [{era, startPos: era.position, endPos: windowEnd}]
 *  - Multiple eras → consecutive endPos chain; last span runs to windowEnd
 *  - Back-to-back eras at same position → zero-width span produced
 *    (`startPos === endPos`); callers may filter — the helper does not.
 *
 * Pure function: no React, no DOM, no side effects.
 */
export function inferEraSpans(sorted: TimelinePin[], windowEnd: number): EraSpan[] {
  const eras = sorted.filter((p) => p.precision === 'era');
  return eras.map((era, i) => ({
    era,
    startPos: era.position,
    endPos: i + 1 < eras.length ? eras[i + 1].position : windowEnd,
  }));
}
