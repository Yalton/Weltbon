import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


// audit: each string must live in the file that owns the empty state. These
// are user-facing copy and should never silently change.
const SRC = resolve(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');


// ("Pin a moment to your timeline") was removed when the vertical grouped-list
// rendering path was replaced by the horizontal canvas + configure-range gate

// other places: TimelineRangeDialog (first-visit prompt) and
// TimelineEntryPanel (right-hand list with locked "No entries" copy). Neither
// needs a static-literal audit here — TimelineRangeDialog's locked copy is
// already covered by its own test file, and TimelineEntryPanel's "No entries"
// copy is asserted in its component test.
const CASES: Array<{ rel: string; copy: string }> = [
  { rel: 'views/EntryList.tsx', copy: 'Start with one idea' },
  // Wave-1 visual overhaul (Cosmic Observatory): the sidebar's category
  // empty state became a compact promo card; canonical copy updated from
  // "Group your entries" to the sentence below (approved copy change).
  { rel: 'components/Sidebar.tsx', copy: 'Categories let you organise entries into folders.' },
  { rel: 'views/IssuesView.tsx', copy: 'Nothing flagged yet' },
  { rel: 'views/UniverseList.tsx', copy: 'Start a universe' },
];

describe('empty-state copy', () => {
  for (const { rel, copy } of CASES) {
    it(`${rel} contains the canonical empty-state title "${copy}"`, () => {
      const src = read(rel);
      expect(src.includes(copy), `expected ${rel} to contain literal: ${copy}`).toBe(true);
    });
  }
});
