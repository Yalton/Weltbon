import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// POL-04 Task 4 — empty-state copy strings from UI-SPEC §9.2. Static-literal
// audit: each string must live in the file that owns the empty state. These
// are user-facing copy and should never silently change.
const SRC = resolve(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

const CASES: Array<{ rel: string; copy: string }> = [
  { rel: 'views/EntryList.tsx', copy: 'Start with one idea' },
  { rel: 'components/Sidebar.tsx', copy: 'Group your entries' },
  { rel: 'views/IssuesView.tsx', copy: 'Nothing flagged yet' },
  { rel: 'views/TimelineView.tsx', copy: 'Pin a moment to your timeline' },
  { rel: 'views/UniverseList.tsx', copy: 'Start a universe' },
];

describe('empty-state copy (POL-04 Task 4)', () => {
  for (const { rel, copy } of CASES) {
    it(`${rel} contains the canonical empty-state title "${copy}"`, () => {
      const src = read(rel);
      expect(src.includes(copy), `expected ${rel} to contain literal: ${copy}`).toBe(true);
    });
  }
});
