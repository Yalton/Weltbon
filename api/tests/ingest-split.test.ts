import { describe, it, expect } from 'vitest';
import {
  sectionCountsByLevel,
  detectSplitLevel,
  splitMarkdownFile,
} from '../src/services/ingest-split.js';

const f = (content: string) => ({ path: 'regions.md', content });

describe('detectSplitLevel', () => {
  it('picks H2 for the common one-title-many-sections shape', () => {
    const doc = '# Regions\n\nIntro.\n\n## Vale\n\nA.\n\n## Frostmere\n\nB.\n';
    expect(detectSplitLevel(doc)).toBe(2);
  });

  it('picks H1 when the document is several chapters', () => {
    const doc = '# Vale\n\n## Geography\n\nA.\n\n# Frostmere\n\n## Geography\n\nB.\n';
    expect(detectSplitLevel(doc)).toBe(1);
  });

  it('returns null when no level repeats', () => {
    expect(detectSplitLevel('# Only\n\nBody.\n\n## Sub\n\nMore.\n')).toBeNull();
  });

  it('ignores headings inside fenced code', () => {
    // Without AST-based detection this reads as two H2s and splits a document
    // that is showing an example of its own format.
    const doc = '# Doc\n\n## Real\n\n```md\n## Not a heading\n## Also not\n```\n';
    expect(detectSplitLevel(doc)).toBeNull();
  });

  it('sees setext headings, which a ^#+ regex cannot', () => {
    const doc = 'Vale\n====\n\nA.\n\nFrostmere\n=========\n\nB.\n';
    expect(detectSplitLevel(doc)).toBe(1);
  });

  it('ignores frontmatter', () => {
    const doc = '---\ntitle: Regions\n---\n\n## Vale\n\nA.\n\n## Frostmere\n\nB.\n';
    expect(detectSplitLevel(doc)).toBe(2);
  });
});

describe('sectionCountsByLevel', () => {
  it('reports the entry count for every level present', () => {
    const doc = '# A\n\n## B\n\n## C\n\n### D\n\n# E\n\n## F\n';
    // H1: 2 sections. H2: 3 sections. H3: 1 section.
    expect(sectionCountsByLevel(doc)).toEqual({ 1: 2, 2: 3, 3: 1 });
  });

  it('counts a leading preamble as one extra entry', () => {
    const doc = 'Intro prose.\n\n## Vale\n\nA.\n\n## Frostmere\n\nB.\n';
    expect(sectionCountsByLevel(doc)[2]).toBe(3); // preamble + 2 sections
  });
});

describe('splitMarkdownFile', () => {
  it('emits one file per section, titled from its heading via frontmatter', () => {
    const doc = '# Regions\n\nIntro.\n\n## Vale\n\nGreen.\n\n## Frostmere\n\nCold.\n';
    const out = splitMarkdownFile(f(doc), 2);

    // preamble + 2 sections
    expect(out).toHaveLength(3);
    expect(out[1].content).toContain('title: Vale');
    expect(out[1].content).toContain('## Vale');
    expect(out[1].content).toContain('Green.');
    expect(out[2].content).toContain('title: Frostmere');
    expect(out[2].content).toContain('Cold.');
  });

  it('preserves the section body byte-for-byte — never re-serializes the AST', () => {
    // Deliberately non-canonical markdown: a re-stringified AST would rewrite
    // the list marker, the emphasis character and the ragged spacing.
    const body = '*   loose item\n*   another\n\n_emphasis_   with   spaces\n';
    const doc = `## Vale\n\n${body}\n## Frostmere\n\nB.\n`;
    const out = splitMarkdownFile(f(doc), 2);
    expect(out[0].content).toContain(body);
  });

  it('gives preamble text its own entry titled from the document', () => {
    const doc = '---\ntitle: Regions of the North\n---\n\nIntro prose.\n\n## Vale\n\nA.\n\n## Frostmere\n\nB.\n';
    const out = splitMarkdownFile(f(doc), 2);
    expect(out).toHaveLength(3);
    expect(out[0].content).toContain('title: Regions of the North');
    expect(out[0].content).toContain('Intro prose.');
  });

  it('creates no preamble entry when there is nothing before the first heading', () => {
    const doc = '## Vale\n\nA.\n\n## Frostmere\n\nB.\n';
    const out = splitMarkdownFile(f(doc), 2);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain('title: Vale');
  });

  it('creates no preamble entry when the preamble is whitespace only', () => {
    const doc = '\n\n   \n\n## Vale\n\nA.\n';
    expect(splitMarkdownFile(f(doc), 2)).toHaveLength(1);
  });

  it('keeps deeper sections inside their parent', () => {
    const doc = '## Geography\n\nA.\n\n### Rivers\n\nWet.\n\n## History\n\nB.\n';
    const out = splitMarkdownFile(f(doc), 2);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain('### Rivers');
    expect(out[0].content).toContain('Wet.');
    expect(out[1].content).not.toContain('Rivers');
  });

  it('still emits an entry for a heading with an empty body', () => {
    const doc = '## Vale\n\n## Frostmere\n\nB.\n';
    const out = splitMarkdownFile(f(doc), 2);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain('title: Vale');
  });

  it('carries the document frontmatter onto every section, overriding only title', () => {
    const doc = '---\ntitle: Regions\ntype: location\ntags: [north, cold]\n---\n\n## Vale\n\nA.\n\n## Frostmere\n\nB.\n';
    const out = splitMarkdownFile(f(doc), 2);
    for (const section of out) {
      expect(section.content).toContain('type: location');
      expect(section.content).toContain('north');
    }
    expect(out[0].content).toContain('title: Vale');
    expect(out[1].content).toContain('title: Frostmere');
  });

  it('gives duplicate headings distinct paths so document order survives', () => {
    const doc = '## Geography\n\nA.\n\n## Geography\n\nB.\n';
    const out = splitMarkdownFile(f(doc), 2);
    expect(out).toHaveLength(2);
    expect(out[0].path).not.toBe(out[1].path);
    // Both still carry the same title — collision handling is the batch's job.
    expect(out[0].content).toContain('title: Geography');
    expect(out[1].content).toContain('title: Geography');
  });

  it('returns the file unchanged when the level yields nothing to split', () => {
    const doc = '# Only\n\nBody.\n';
    const out = splitMarkdownFile(f(doc), 2);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('regions.md');
  });

  it('handles a large document without pathological slowdown', () => {
    const doc = Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\nBody ${i}.\n`).join('\n');
    const out = splitMarkdownFile(f(doc), 2);
    expect(out).toHaveLength(200);
    expect(out[199].content).toContain('Body 199.');
  });
});
