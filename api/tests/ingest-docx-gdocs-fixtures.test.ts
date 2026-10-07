/**
 * Google-Docs-shaped worldbuilding notes through convertDocx.
 *
 * The fixtures in fixtures/ingest/docx-gdocs/ are rebuilt by build_gdocs.py.
 * They copy the structure of real Docs exports (no Heading styles, direct run
 * formatting, tab-indented trees, numPr lists, a comment, an empty header)
 * with invented text. Unlike the `docx`-writer fixtures, nothing here was
 * written by a Word-compatible library: this is what Docs actually emits.
 *
 * Every body is also parsed with remark, because the failure mode that
 * matters is Markdown that is valid text but renders as garbage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { convertDocx } from '../src/services/ingest-docx/index.js';
import { splitMarkdownFile, detectSplitLevel } from '../src/services/ingest-split.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ingest', 'docx-gdocs');
const load = (name: string) => readFileSync(join(DIR, name));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdNode = { type: string; value?: string; children?: MdNode[]; ordered?: boolean };

function mdTree(markdown: string): MdNode {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown) as unknown as MdNode;
}

function nodes(tree: MdNode, type: string): MdNode[] {
  const out: MdNode[] = [];
  const walk = (n: MdNode) => {
    if (n.type === type) out.push(n);
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

/** Literal emphasis markers that survived parsing as text = broken emphasis. */
function strayMarkers(tree: MdNode): string[] {
  return nodes(tree, 'text').map((n) => n.value ?? '').filter((v) => /\*\*|(^|\s)\*\S/.test(v));
}

const codes = (warnings: Array<{ code: string }>) => warnings.map((w) => w.code).sort();

describe('Google Docs fixture: pantheon-tabs.docx (tab-indented tree)', () => {
  it('keeps every name, emits no code block and no broken emphasis', async () => {
    const c = await convertDocx(load('pantheon-tabs.docx'), {});
    const tree = mdTree(c.markdown);

    for (const name of ['Ostra', 'Vell', 'Dorn', 'Ilsa', 'Pell', 'Quen', 'Tamsin', 'Corvane',
      'Hesk', 'Brannoch', 'Liss', 'Mereth', 'Gath’Orrin', 'Ruvane', 'Selk']) {
      expect(c.markdown).toContain(name);
    }
    // Three leading tabs must not become a four-space indented code block.
    expect(nodes(tree, 'code')).toHaveLength(0);
    expect(c.markdown).not.toMatch(/^ {4}/m);
    expect(strayMarkers(tree)).toEqual([]);
    // Bold+underline name runs keep the bold, lose the underline (with a warning).
    expect(nodes(tree, 'strong').length).toBe(6);
    expect(c.markdown).toContain('**Vell** (Keeper of Hours)');
    // Pipes are escaped in prose and come back as literal text.
    expect(c.markdown).toContain('{Brannoch\\|\\|Liss}');
    expect(nodes(tree, 'table')).toHaveLength(0);
  });

  it('warns about dropped underline and missing headings, nothing else', async () => {
    const c = await convertDocx(load('pantheon-tabs.docx'), {});
    expect(codes(c.warnings)).toEqual(['formatting-dropped', 'no-headings']);
    expect(c.headings).toEqual({ styled: 0, unstyledCandidates: 0, promoted: false });
  });
});

describe('Google Docs fixture: ranked-orders.docx (numPr lists + header part)', () => {
  it('turns the decimal numbering into one ordered list of six items', async () => {
    const c = await convertDocx(load('ranked-orders.docx'), {});
    const lists = nodes(mdTree(c.markdown), 'list');
    const ordered = lists.filter((l) => l.ordered);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].children).toHaveLength(6);
    expect(c.markdown).toContain('1. Guild Masters: Sit on the river council');
    expect(c.markdown).toContain('The Weigher & The Tallyman:');
  });

  it('turns the bullet numbering into bullet lists, keeping the nested level', async () => {
    const c = await convertDocx(load('ranked-orders.docx'), {});
    const bullets = nodes(mdTree(c.markdown), 'list').filter((l) => !l.ordered);
    // Two chapter lists plus the nested one under "Meet the tallyman".
    expect(bullets).toHaveLength(3);
    expect(c.markdown).toContain('- Meet the tallyman\n  - Dispute over the scales');
    expect(c.markdown).toMatch(/^Chapter 1 *$/m);
  });

  it('imports quietly apart from the no-headings note', async () => {
    const c = await convertDocx(load('ranked-orders.docx'), {});
    expect(codes(c.warnings)).toEqual(['no-headings']);
    expect(c.media).toEqual([]);
  });
});

describe('Google Docs fixture: chronicle.docx (unstyled era headings)', () => {
  it('finds the three bold+underlined era lines as heading candidates only', async () => {
    const c = await convertDocx(load('chronicle.docx'), {});
    expect(c.headings).toEqual({ styled: 0, unstyledCandidates: 3, promoted: false });
    expect(codes(c.warnings)).toEqual([
      'comments-dropped', 'formatting-dropped', 'no-headings', 'unstyled-headings-detected',
    ]);
    expect(c.markdown).not.toMatch(/^#/m);
    expect(c.markdown).not.toContain('Check this date');
  });

  it('keeps timeline lines as text and escapes a fake list marker', async () => {
    const c = await convertDocx(load('chronicle.docx'), {});
    const tree = mdTree(c.markdown);
    expect(c.markdown).toContain('1,200 BC/0: The first raft crosses the ford');
    expect(c.markdown).toContain('950 B.C: The stone bridge is finished');
    expect(c.markdown).toContain('1\\. This line only looks like a list item');
    expect(nodes(tree, 'list')).toHaveLength(0);
  });

  it('does not open a paragraph with a stray hard break', async () => {
    const c = await convertDocx(load('chronicle.docx'), {});
    expect(c.markdown).not.toMatch(/^\\$/m);
    expect(nodes(mdTree(c.markdown), 'break')).toHaveLength(0);
  });

  it('with promotion on, splits into one entry per era', async () => {
    const c = await convertDocx(load('chronicle.docx'), { promoteHeadings: true });
    expect(c.headings.promoted).toBe(true);
    expect(c.markdown).toMatch(/^# The Quiet Era$/m);
    const level = detectSplitLevel(c.markdown);
    expect(level).toBe(1);
    const parts = splitMarkdownFile({ path: 'chronicle.md', content: c.markdown }, level!);
    expect(parts.map((p) => p.path)).toEqual([
      'chronicle/00-the-quiet-era.md',
      'chronicle/01-the-era-of-wardens.md',
      'chronicle/02-the-long-argument.md',
    ]);
  });

  // Weltbon-izk: a bold opening quote mark followed by plain text emits
  // `**“**Who`, whose closing ** is not right-flanking, so the asterisks
  // render literally. Flip to it() when that bead lands.
  it.fails('renders a bold opening quote mark without literal asterisks', async () => {
    const c = await convertDocx(load('chronicle.docx'), {});
    expect(strayMarkers(mdTree(c.markdown))).toEqual([]);
  });
});
