import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Heading } from 'mdast';
import { normalizeFilename } from './ingest-filename.js';
import type { FileInput } from './ingest-markdown.js';

export type SplitLevel = 1 | 2 | 3 | 4 | 5 | 6;


type Boundary = { level: SplitLevel; title: string; start: number };
type Parsed = { tree: Root; boundaries: Boundary[] };

function parse(body: string): Parsed {
  const tree = unified().use(remarkParse).parse(body) as Root;
  const boundaries: Boundary[] = [];
  for (const node of tree.children) {
    if (node.type !== 'heading') continue;
    const h = node as Heading;
    const start = h.position?.start?.offset;
    if (start === undefined) continue;
    boundaries.push({
      level: h.depth as SplitLevel,
      title: headingText(h, body),
      start,
    });
  }
  return { tree, boundaries };
}

function hasPreambleContent(tree: Root, cutoff: number): boolean {
  return tree.children.some((n) => {
    const start = n.position?.start?.offset;
    return start !== undefined && start < cutoff && n.type !== 'heading';
  });
}

function headingText(h: Heading, body: string): string {
  const s = h.position?.start?.offset ?? 0;
  const e = h.position?.end?.offset ?? s;
  return body
    .slice(s, e)
    .replace(/^#{1,6}\s+/, '')   // ATX prefix
    .replace(/\s+#*\s*$/, '')     // optional ATX closing run
    .replace(/\n[=-]+\s*$/, '')   // setext underline
    .trim();
}

export function sectionCountsByLevel(content: string): Partial<Record<SplitLevel, number>> {
  const { content: body } = matter(content);
  const { tree, boundaries } = parse(body);
  const counts: Partial<Record<SplitLevel, number>> = {};
  for (const level of [1, 2, 3, 4, 5, 6] as SplitLevel[]) {
    const at = boundaries.filter((h) => h.level === level);
    if (at.length === 0) continue;
    const hasPreamble = hasPreambleContent(tree, at[0].start);
    counts[level] = at.length + (hasPreamble ? 1 : 0);
  }
  return counts;
}

export function detectSplitLevel(content: string): SplitLevel | null {
  const { content: body } = matter(content);
  const { boundaries: hs } = parse(body);
  for (const level of [1, 2, 3, 4, 5, 6] as SplitLevel[]) {
    if (hs.filter((h) => h.level === level).length > 1) return level;
  }
  return null;
}

function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s === '' ? 'section' : s;
}

export function splitMarkdownFile(file: FileInput, level: SplitLevel): FileInput[] {
  const parsed = matter(file.content);
  const body = parsed.content;
  const data = parsed.data as Record<string, unknown>;
  const { tree, boundaries } = parse(body);
  const at = boundaries.filter((h) => h.level === level);

  if (at.length < 2) return [file];

  const base = file.path.replace(/\.md$/i, '');

  // the ORIGINAL basename (not the synthetic per-section path) matters
  // because normalizeFilename must see 'regions.md', not '00-regions.md'.
  const preambleHeading = boundaries.find((h) => h.start < at[0].start);
  const docTitle =
    typeof data.title === 'string' && data.title.trim() !== ''
      ? data.title.trim()
      : preambleHeading
        ? preambleHeading.title
        : normalizeFilename(base.split('/').pop()!);

  const out: FileInput[] = [];

  const emit = (title: string, sectionBody: string, index: number) => {
    const fm = { ...data, title };
    out.push({
      path: `${base}/${String(index).padStart(2, '0')}-${slug(title)}.md`,
      content: matter.stringify(sectionBody, fm),
    });
  };

  const preamble = body.slice(0, at[0].start);
  if (hasPreambleContent(tree, at[0].start)) emit(docTitle, preamble, out.length);

  for (let i = 0; i < at.length; i++) {
    const start = at[i].start;
    const end = i + 1 < at.length ? at[i + 1].start : body.length;
    emit(at[i].title, body.slice(start, end), out.length);
  }

  return out;
}
