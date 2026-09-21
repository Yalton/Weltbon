export interface TimelinePin {
  id: string;
  entryId: string;
  label: string;
  position: number;
  precision: 'exact' | 'approximate' | 'era';
  entryTitle?: string;
  entryIcon?: string;
  entryType?: string;
}

export interface Group {
  era: TimelinePin | null;
  pins: TimelinePin[];
}

export function groupByEra(sorted: TimelinePin[]): Group[] {
  const groups: Group[] = [];
  let current: Group = { era: null, pins: [] };
  for (const p of sorted) {
    if (p.precision === 'era') {
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

export interface EraSpan {
  era: TimelinePin;
  startPos: number;
  endPos: number;
}

export function inferEraSpans(sorted: TimelinePin[], windowEnd: number): EraSpan[] {
  const eras = sorted.filter((p) => p.precision === 'era');
  return eras.map((era, i) => ({
    era,
    startPos: era.position,
    endPos: i + 1 < eras.length ? eras[i + 1].position : windowEnd,
  }));
}
