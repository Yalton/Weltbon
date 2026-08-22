import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Heading } from 'mdast';
import { normalizeFilename, type FileInput } from './ingest-markdown.js';

export type SplitLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Issue #37. Split one structured Markdown document into one virtual file per
 * section, so the existing ingest pipeline turns it into one entry per section.
 *
 * PURE AND TOTAL. No IO, no throwing, no policy — every input yields a valid
 * result. The post-split entry cap is the route's job, not this module's.
 *
 * BOUNDARIES COME FROM THE REMARK AST, not a regex, for two reasons that a
 * regex cannot give: a heading inside a fenced code block is not a boundary (a
 * worldbuilding document may show an example of its own format), and a setext
 * heading — `Title` underlined with `====` — is a real heading that `^#+`
 * never matches.
 *
 * BODIES ARE SLICED, NEVER RE-SERIALIZED. Section text comes from
 * `body.slice(start, end)` using node offsets. Stringifying the AST back to
 * Markdown would normalize list markers, emphasis characters and whitespace —
 * silently rewriting prose the user wrote.
 */

type Boundary = { level: SplitLevel; title: string; start: number };
type Parsed = { tree: Root; boundaries: Boundary[] };

/** Parse once and return both the full tree and the heading boundaries with their source offsets. */
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

/**
 * Whether the region before `cutoff` holds real content — a paragraph, list,
 * code block, etc. — as opposed to nothing but shallower headings. A
 * document that opens with `# Title` followed immediately by `## Vale` has
 * no preamble to split at level 2: the "# Title" line is the document's own
 * heading, not prose the split would otherwise strand without an entry.
 */
function hasPreambleContent(tree: Root, cutoff: number): boolean {
  return tree.children.some((n) => {
    const start = n.position?.start?.offset;
    return start !== undefined && start < cutoff && n.type !== 'heading';
  });
}

/**
 * The heading's text. Taken from the source slice rather than the AST's text
 * children so inline markup (`## The *Vale*`) survives into the title the way
 * the author wrote it.
 */
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
    // "More than once" — a level appearing once is a document title, not a
    // boundary, so splitting there would just relabel the whole document.
    if (hs.filter((h) => h.level === level).length > 1) return level;
  }
  return null;
}

/** Slug for a synthetic path segment. Falls back to 'section' when a title has no word characters. */
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

  // docTitle precedence (#37 fix-round-1): frontmatter title, else the text
  // of the first heading that actually precedes the first split boundary —
  // i.e. the document's own heading, at any level — else the normalized
  // ORIGINAL filename. `boundaries` is in document order and includes every
  // heading level (not just `level`), so the first entry with a start before
  // `at[0].start` is that preamble heading, if the document has one; using
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
    // Frontmatter carries the title because inferTitle reads `data.title`
    // FIRST and only matches a leading H1 otherwise — an H2+ section would
    // fall through to the filename. Every other key is inherited: a section
    // belongs to the document its author wrote it under.
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
