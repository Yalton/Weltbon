import { describe, it, expect } from 'vitest';
import { parseBatch, type ParseBatchContext } from '../src/services/ingest-markdown.js';

const ctx = (over: Partial<ParseBatchContext> = {}): ParseBatchContext => ({
  universeId: '00000000-0000-0000-0000-000000000000',
  validTypes: ['concept', 'location'],
  existingEntries: [],
  existingCategories: [],
  ...over,
});

const doc = (content: string) => [{ path: 'regions.md', content }];

describe('parseBatch with splitLevel (SP-02)', () => {
  it('produces one entry per section instead of one per file', () => {
    const preview = parseBatch(
      doc('# Regions\n\nIntro.\n\n## Vale\n\nA.\n\n## Frostmere\n\nB.\n'),
      ctx({ splitLevel: 2 }),
    );
    expect(preview.entries.map((e) => e.title)).toEqual(['Regions', 'Vale', 'Frostmere']);
  });

  it('is unchanged when splitLevel is absent', () => {
    const preview = parseBatch(
      doc('# Regions\n\n## Vale\n\nA.\n\n## Frostmere\n\nB.\n'),
      ctx(),
    );
    expect(preview.entries).toHaveLength(1);
  });

  // ── The two behaviours SP-02 claims come for free. Claiming is not enough. ──

  it('resolves a wikilink from one section to another section (D-06)', () => {
    const preview = parseBatch(
      doc('## Vale\n\nBorders [[Frostmere]].\n\n## Frostmere\n\nCold.\n'),
      ctx({ splitLevel: 2 }),
    );
    const vale = preview.entries.find((e) => e.title === 'Vale')!;
    const link = vale.linksOut.find((l) => l.target === 'Frostmere');
    expect(link).toBeDefined();
    expect(link!.resolved).toBe(true);
  });

  it('reports two same-titled sections as a duplicate-title collision (D-05)', () => {
    const preview = parseBatch(
      doc('## Geography\n\nA.\n\n## Geography\n\nB.\n'),
      ctx({ splitLevel: 2 }),
    );
    expect(preview.entries).toHaveLength(2);
    expect(preview.summary.duplicate_titles_in_batch).toBeGreaterThan(0);
    // Per-entry too, not just the summary count — the reviewer renders its
    // conflict chip from this flag, so this is what the user actually sees.
    expect(preview.entries.some((e) => e.titleCollision === true)).toBe(true);
  });

  it('does not split when the batch holds more than one markdown file (SP-01)', () => {
    const preview = parseBatch(
      [
        { path: 'a.md', content: '## One\n\nA.\n\n## Two\n\nB.\n' },
        { path: 'b.md', content: '## Three\n\nC.\n' },
      ],
      ctx({ splitLevel: 2 }),
    );
    expect(preview.entries).toHaveLength(2);
  });
});
