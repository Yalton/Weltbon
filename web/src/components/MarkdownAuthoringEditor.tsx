import {
  codeBlockPlugin,
  diffSourcePlugin,
  headingsPlugin,
  imagePlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
} from '@mdxeditor/editor';
import { fromMarkdown } from 'mdast-util-from-markdown';
import '@mdxeditor/editor/style.css';
import './MarkdownAuthoringEditor.css';
import { MarkdownAuthoringToolbar } from './MarkdownAuthoringToolbar';
import { MarkdownCommandPalette } from './MarkdownCommandPalette';
import { MarkdownFrontmatterPanel } from './MarkdownFrontmatterPanel';
import { MarkdownLinkDialog, parseMarkdownLink, type MarkdownLinkKind } from './MarkdownLinkDialog';
import { WikilinkAutocomplete } from './WikilinkAutocomplete';
import {
  findMalformedMarkdownTableRanges,
  findMarkdownTableRanges,
  MarkdownTableControls,
} from './MarkdownTableControls';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { parseMarkdownFrontmatter } from '../lib/markdownAuthoring';

export type MarkdownAuthoringEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  universeId: string;
  entryId?: string;
  disabled?: boolean;
};

export type MarkdownAuthoringSelection = { start: number; end: number };

export type MarkdownHeading = {
  anchor: string;
  depth: number;
  start: number;
  end: number;
  text: string;
};

export type MarkdownAuthoringEditorHandle = {
  insertMarkdown: (markdown: string) => void;
  executeCommand: (command: MarkdownAuthoringCommandId) => void;
  navigateToHeading: (anchor: string) => void;
  revealSelection: (selection: MarkdownAuthoringSelection) => void;
  replaceSelection: (selection: MarkdownAuthoringSelection, markdown: string) => void;
};

export type MarkdownAuthoringCommandId =
  | 'paragraph' | 'heading-1' | 'quote' | 'callout-note' | 'callout-tip' | 'callout-warning'
  | 'bullet-list' | 'ordered-list' | 'task-list' | 'code-block' | 'horizontal-rule'
  | 'bold' | 'italic' | 'strikethrough' | 'inline-code' | 'clear-formatting' | 'link';

export type MarkdownAuthoringCommand = {
  id: MarkdownAuthoringCommandId;
  label: string;
  shortLabel: string;
  markdown: string;
  shortcut?: string;
};

export const markdownAuthoringCommands: readonly MarkdownAuthoringCommand[] = [
  { id: 'paragraph', label: 'Paragraph', shortLabel: '¶', markdown: 'Paragraph' },
  { id: 'heading-1', label: 'Heading 1', shortLabel: 'H1', markdown: '# Heading' },
  { id: 'quote', label: 'Quote', shortLabel: '❝', markdown: '> Quote' },
  { id: 'callout-note', label: 'Note callout', shortLabel: 'Note', markdown: '> [!NOTE]\n> Callout' },
  { id: 'callout-tip', label: 'Tip callout', shortLabel: 'Tip', markdown: '> [!TIP]\n> Callout' },
  { id: 'callout-warning', label: 'Warning callout', shortLabel: 'Warn', markdown: '> [!WARNING]\n> Callout' },
  { id: 'bullet-list', label: 'Bullet list', shortLabel: '•', markdown: '- Item' },
  { id: 'ordered-list', label: 'Ordered list', shortLabel: '1.', markdown: '1. Item' },
  { id: 'task-list', label: 'Task list', shortLabel: '☐', markdown: '- [ ] Task' },
  { id: 'code-block', label: 'Code block', shortLabel: '</>', markdown: '```\ncode\n```' },
  { id: 'horizontal-rule', label: 'Horizontal rule', shortLabel: '—', markdown: '---' },
  { id: 'bold', label: 'Bold', shortLabel: 'B', markdown: '**bold**', shortcut: 'Ctrl/Cmd-B' },
  { id: 'italic', label: 'Italic', shortLabel: 'I', markdown: '*italic*', shortcut: 'Ctrl/Cmd-I' },
  { id: 'strikethrough', label: 'Strikethrough', shortLabel: 'S', markdown: '~~strikethrough~~' },
  { id: 'inline-code', label: 'Inline code', shortLabel: '`', markdown: '`code`' },
  { id: 'clear-formatting', label: 'Clear formatting', shortLabel: 'Clear', markdown: 'Plain text' },
  { id: 'link', label: 'Link', shortLabel: 'Link', markdown: '[link text](https://)', shortcut: 'Ctrl/Cmd-K' },
];

type Selection = MarkdownAuthoringSelection;
type MarkdownPart = { kind: 'markdown' | 'raw'; content: string };

function sameSelection(left: Selection | null, right: Selection | null): boolean {
  return left?.start === right?.start && left?.end === right?.end;
}

const generatedHeadingWhitespace = /(?:[ \t]*(?:&#x20;|&#32;))+[ \t]*$/i;
const markdownFence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const markdownBlockquotePrefix = /^ {0,3}>[ \t]?/;
const markdownListPrefix = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

type MarkdownBlockPrefix = { kind: 'blockquote' | 'list'; length: number };
type MarkdownFence = { marker: string; length: number; container: { prefixes: MarkdownBlockPrefix[] } };
type HeadingWhitespaceCandidate = {
  lineIndex: number;
  key: string;
  prefix: string;
  body: string;
};

function markdownBlockPrefixes(prefix: string): MarkdownBlockPrefix[] {
  const prefixes: MarkdownBlockPrefix[] = [];
  let remainder = prefix;
  let match: RegExpExecArray | null;
  while (remainder.length > 0) {
    match = markdownBlockquotePrefix.exec(remainder);
    if (match) {
      prefixes.push({ kind: 'blockquote', length: match[0].length });
      remainder = remainder.slice(match[0].length);
      continue;
    }
    match = markdownListPrefix.exec(remainder);
    if (match) {
      prefixes.push({ kind: 'list', length: match[0].length });
      remainder = remainder.slice(match[0].length);
      continue;
    }
    break;
  }
  return prefixes;
}

function markdownBlockPrefixEnd(line: string): number {
  return markdownBlockPrefixes(line).reduce((length, prefix) => length + prefix.length, 0);
}

function headingPrefixEnd(line: string): number | null {
  const index = markdownBlockPrefixEnd(line);
  return /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line.slice(index)) ? index : null;
}

function fenceContainer(prefix: string): { prefixes: MarkdownBlockPrefix[] } {
  return { prefixes: markdownBlockPrefixes(prefix) };
}

function fenceContentLine(line: string, container: { prefixes: MarkdownBlockPrefix[] }): string | null {
  if (line.trim() === '') return '';
  let remainder = line;
  for (const prefix of container.prefixes) {
    if (prefix.kind === 'blockquote') {
      const match = markdownBlockquotePrefix.exec(remainder);
      if (!match) return null;
      remainder = remainder.slice(match[0].length);
      continue;
    }
    const indentation = remainder.match(/^ */)?.[0].length ?? 0;
    if (indentation < prefix.length) return null;
    remainder = remainder.slice(prefix.length);
  }
  return remainder;
}

function sameMarkdownContainer(
  left: { prefixes: MarkdownBlockPrefix[] },
  right: { prefixes: MarkdownBlockPrefix[]; indentation: number },
): boolean {
  if (left.prefixes.length === right.prefixes.length && left.prefixes.every(
    (prefix, index) => prefix.kind === right.prefixes[index].kind,
  )) return true;
  for (let start = 0; start <= left.prefixes.length; start += 1) {
    if (!left.prefixes.slice(0, start).every((prefix) => prefix.kind === 'list')) continue;
    for (let end = start; end <= left.prefixes.length; end += 1) {
      if (!left.prefixes.slice(end).every((prefix) => prefix.kind === 'list')) continue;
      const matched = left.prefixes.slice(start, end);
      if (matched.length !== right.prefixes.length || !matched.every(
        (prefix, index) => prefix.kind === right.prefixes[index].kind,
      )) continue;
      const requiredIndentation = [...left.prefixes.slice(0, start), ...left.prefixes.slice(end)]
        .reduce((total, prefix) => total + prefix.length, 0);
      if (right.indentation >= requiredIndentation) return true;
    }
  }
  return false;
}

function openingFenceMarker(line: string): string | null {
  const match = line.match(markdownFence);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return match[1];
}

function isClosingFence(line: string, fence: MarkdownFence): boolean {
  const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line;
  const fenceLine = fenceContentLine(normalizedLine, fence.container);
  return fenceLine !== null && new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`).test(fenceLine);
}

function headingWhitespaceCandidates(markdown: string): HeadingWhitespaceCandidate[] {
  const candidates: HeadingWhitespaceCandidate[] = [];
  let fence: MarkdownFence | null = null;
  markdown.split('\n').forEach((line, lineIndex) => {
    const prefixEnd = markdownBlockPrefixEnd(line);
    if (fence) {
      const fenceLine = fenceContentLine(line, fence.container);
      if (fenceLine !== null) {
        if (isClosingFence(line, fence)) fence = null;
        return;
      }
      fence = null;
    }
    const openingFence = openingFenceMarker(line.slice(prefixEnd));
    if (openingFence) {
      fence = {
        marker: openingFence[0],
        length: openingFence.length,
        container: fenceContainer(line.slice(0, prefixEnd)),
      };
      return;
    }
    const headingEnd = headingPrefixEnd(line);
    if (headingEnd === null) return;
    const content = line.slice(headingEnd);
    if (!generatedHeadingWhitespace.test(content)) return;
    const body = content.replace(generatedHeadingWhitespace, '');
    candidates.push({
      lineIndex,
      key: `${line.slice(0, headingEnd)}${body}`,
      prefix: line.slice(0, headingEnd),
      body,
    });
  });
  return candidates;
}

function headingCandidateScore(previous: HeadingWhitespaceCandidate, current: HeadingWhitespaceCandidate): number {
  const commonPrefix = (() => {
    let length = 0;
    while (length < previous.body.length && length < current.body.length && previous.body[length] === current.body[length]) length += 1;
    return length;
  })();
  const commonSuffix = (() => {
    let length = 0;
    while (
      length < previous.body.length
      && length < current.body.length
      && previous.body[previous.body.length - length - 1] === current.body[current.body.length - length - 1]
    ) length += 1;
    return length;
  })();
  return (previous.prefix === current.prefix ? 100 : 0)
    + Math.min(commonPrefix, 12) * 2
    + Math.min(commonSuffix, 12)
    - Math.abs(previous.lineIndex - current.lineIndex) * 0.01;
}

function preservedHeadingLines(markdown: string, previousMarkdown: string | undefined): Set<number> {
  if (!previousMarkdown) return new Set();
  const previous = headingWhitespaceCandidates(previousMarkdown);
  const current = headingWhitespaceCandidates(markdown);
  const preserved = new Set<number>();
  const unmatchedPrevious = new Set(previous.map((_, index) => index));
  const unmatchedCurrent = new Set(current.map((_, index) => index));
  const previousByKey = new Map<string, number[]>();
  previous.forEach((candidate, index) => {
    const matches = previousByKey.get(candidate.key) ?? [];
    matches.push(index);
    previousByKey.set(candidate.key, matches);
  });

  current.forEach((candidate, currentIndex) => {
    const matches = previousByKey.get(candidate.key);
    const previousIndex = matches?.find((index) => unmatchedPrevious.has(index));
    if (previousIndex === undefined) return;
    unmatchedPrevious.delete(previousIndex);
    unmatchedCurrent.delete(currentIndex);
    preserved.add(candidate.lineIndex);
  });

  while (unmatchedPrevious.size > 0 && unmatchedCurrent.size > 0) {
    let bestPrevious = -1;
    let bestCurrent = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    unmatchedPrevious.forEach((previousIndex) => {
      unmatchedCurrent.forEach((currentIndex) => {
        const score = headingCandidateScore(previous[previousIndex], current[currentIndex]);
        if (score > bestScore) {
          bestPrevious = previousIndex;
          bestCurrent = currentIndex;
          bestScore = score;
        }
      });
    });
    if (bestPrevious === -1 || bestCurrent === -1) break;
    unmatchedPrevious.delete(bestPrevious);
    unmatchedCurrent.delete(bestCurrent);
    preserved.add(current[bestCurrent].lineIndex);
  }
  return preserved;
}

export function canonicalizeLiveMarkdown(markdown: string, previousMarkdown?: string): string {
  let fence: MarkdownFence | null = null;
  const preservedLines = preservedHeadingLines(markdown, previousMarkdown);
  return markdown.split('\n').map((line, lineIndex) => {
    const prefixEnd = markdownBlockPrefixEnd(line);
    if (fence) {
      const fenceLine = fenceContentLine(line, fence.container);
      if (fenceLine !== null) {
        if (isClosingFence(line, fence)) fence = null;
        return line;
      }
      fence = null;
    }
    const openingFence = openingFenceMarker(line.slice(prefixEnd));
    if (openingFence) {
      fence = {
        marker: openingFence[0],
        length: openingFence.length,
        container: fenceContainer(line.slice(0, prefixEnd)),
      };
      return line;
    }
    const headingEnd = headingPrefixEnd(line);
    if (headingEnd === null) return line;
    if (preservedLines.has(lineIndex)) {
      return line;
    }
    return `${line.slice(0, headingEnd)}${line.slice(headingEnd).replace(generatedHeadingWhitespace, '')}`;
  }).join('\n');
}

const editorPlugins = [
  headingsPlugin(),
  markdownShortcutPlugin(),
  listsPlugin(),
  quotePlugin(),
  codeBlockPlugin(),
  thematicBreakPlugin(),
  tablePlugin(),
  linkPlugin(),
  imagePlugin(),
  diffSourcePlugin({ viewMode: 'rich-text' }),
];

function markdownFenceProtectedLines(markdown: string): boolean[] {
  const lines = markdown.split('\n');
  const protectedLines = lines.map(() => false);
  let fence: MarkdownFence | null = null;

  lines.forEach((line, index) => {
    const prefixEnd = markdownBlockPrefixEnd(line);
    if (fence) {
      const fenceLine = fenceContentLine(line, fence.container);
      if (fenceLine !== null) {
        protectedLines[index] = true;
        if (isClosingFence(line, fence)) fence = null;
        return;
      }
      fence = null;
    }
    const openingFence = openingFenceMarker(line.slice(prefixEnd));
    if (!openingFence) return;
    protectedLines[index] = true;
    fence = {
      marker: openingFence[0],
      length: openingFence.length,
      container: fenceContainer(line.slice(0, prefixEnd)),
    };
  });

  return protectedLines;
}

function unsupportedDirectiveRanges(markdown: string): Array<{ start: number; end: number }> {
  const lines = markdown.split('\n');
  const protectedLines = markdownFenceProtectedLines(markdown);
  const starts: number[] = [];
  let offset = 0;
  lines.forEach((line) => {
    starts.push(offset);
    offset += line.length + 1;
  });

  const ranges: Array<{ start: number; end: number }> = [];
  let directiveStart = -1;
  let directiveContainer: { prefixes: MarkdownBlockPrefix[] } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (directiveStart !== -1) {
      const body = lines[index].slice(markdownBlockPrefixEnd(lines[index]));
      const prefixEnd = markdownBlockPrefixEnd(lines[index]);
      const currentContainer = {
        ...fenceContainer(lines[index].slice(0, prefixEnd)),
        indentation: lines[index].slice(prefixEnd).match(/^[ \t]*/)?.[0].length ?? 0,
      };
      if (
        !protectedLines[index] &&
        directiveContainer &&
        sameMarkdownContainer(directiveContainer, currentContainer) &&
        /^ {0,3}:::\s*$/.test(body)
      ) {
        ranges.push({ start: starts[directiveStart], end: starts[index] + lines[index].length });
        directiveStart = -1;
        directiveContainer = null;
      }
      continue;
    }
    if (protectedLines[index]) continue;
    const body = lines[index].slice(markdownBlockPrefixEnd(lines[index]));
    if (/^ {0,3}:::\s*\S/.test(body)) {
      directiveStart = index;
      directiveContainer = fenceContainer(lines[index].slice(0, markdownBlockPrefixEnd(lines[index])));
    }
  }
  if (directiveStart !== -1) ranges.push({ start: starts[directiveStart], end: markdown.length });
  return ranges;
}

type MarkdownSourcePoint = { line: number; offset: number };
type MarkdownSourcePosition = { start: MarkdownSourcePoint; end: MarkdownSourcePoint };
type MarkdownBlockquote = {
  children: Array<{ type: string; position?: unknown }>;
  position?: unknown;
};

function isMarkdownSourcePosition(position: unknown, markdownLength: number): position is MarkdownSourcePosition {
  if (typeof position !== 'object' || position === null) return false;
  const candidate = position as { start?: unknown; end?: unknown };
  const isPoint = (point: unknown): point is MarkdownSourcePoint => {
    if (typeof point !== 'object' || point === null) return false;
    const sourcePoint = point as { line?: unknown; offset?: unknown };
    return typeof sourcePoint.line === 'number'
      && Number.isInteger(sourcePoint.line)
      && sourcePoint.line >= 1
      && typeof sourcePoint.offset === 'number'
      && Number.isInteger(sourcePoint.offset)
      && sourcePoint.offset >= 0
      && sourcePoint.offset <= markdownLength;
  };
  if (!isPoint(candidate.start) || !isPoint(candidate.end)) return false;
  return candidate.start.offset <= candidate.end.offset && candidate.start.line <= candidate.end.line;
}

function visitMarkdownBlockquotes(node: unknown, visit: (blockquote: MarkdownBlockquote) => void): void {
  if (typeof node !== 'object' || node === null || !('children' in node) || !Array.isArray(node.children)) return;
  node.children.forEach((child) => {
    if (typeof child === 'object' && child !== null && 'type' in child && child.type === 'blockquote') {
      visit(child as MarkdownBlockquote);
    }
    visitMarkdownBlockquotes(child, visit);
  });
}

function markdownLineStarts(markdown: string): number[] {
  const starts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === '\r') {
      if (markdown[index + 1] === '\n') index += 1;
      starts.push(index + 1);
    } else if (markdown[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function unsupportedCalloutRanges(
  markdown: string,
  lineStarts: number[],
): Array<{ start: number; end: number }> | null {
  const ranges: Array<{ start: number; end: number }> = [];
  const supportedCallouts = new Set(['NOTE', 'TIP', 'WARNING']);

  try {
    const tree = fromMarkdown(markdown);
    visitMarkdownBlockquotes(tree, (blockquote) => {
      if (!isMarkdownSourcePosition(blockquote.position, markdown.length)) {
        throw new Error('Invalid blockquote source position');
      }
      const blockquotePosition = blockquote.position;
      const lineStart = lineStarts[blockquotePosition.start.line - 1];
      if (
        lineStart === undefined
        || lineStart > blockquotePosition.start.offset
        || markdown.slice(lineStart, blockquotePosition.start.offset).match(/[\r\n]/)
        || markdown.lastIndexOf('\n', blockquotePosition.start.offset - 1) + 1 !== lineStart
      ) {
        throw new Error('Invalid blockquote line start');
      }

      const firstChild = blockquote.children[0];
      if (!firstChild || firstChild.type !== 'paragraph') return;
      if (!isMarkdownSourcePosition(firstChild.position, markdown.length)) {
        throw new Error('Invalid paragraph source position');
      }
      if (
        firstChild.position.start.offset < blockquotePosition.start.offset
        || firstChild.position.end.offset > blockquotePosition.end.offset
      ) {
        throw new Error('Invalid paragraph range');
      }

      const marker = markdown.slice(firstChild.position.start.offset).match(/^\[!([A-Za-z][A-Za-z0-9_-]*)\]/);
      if (!marker || supportedCallouts.has(marker[1].toUpperCase())) return;
      if (lineStart > blockquotePosition.end.offset) throw new Error('Invalid callout range');
      ranges.push({ start: lineStart, end: blockquotePosition.end.offset });
    });
    return ranges;
  } catch {
    return null;
  }
}

export function splitUnsupportedBlocks(markdown: string): MarkdownPart[] {
  const ranges: Array<{ start: number; end: number }> = unsupportedDirectiveRanges(markdown);
  const frontmatter = parseMarkdownFrontmatter(markdown);
  if (frontmatter.raw !== null && frontmatter.diagnostics.length === 0) {
    const separator = markdown.slice(frontmatter.raw.length).match(/^\r?\n/)?.[0] ?? '';
    ranges.push({ start: 0, end: frontmatter.raw.length + separator.length });
  }
  const calloutRanges = unsupportedCalloutRanges(markdown, markdownLineStarts(markdown));
  if (calloutRanges === null) return [{ kind: 'raw', content: markdown }];
  ranges.push(...calloutRanges);
  ranges.push(...findMalformedMarkdownTableRanges(markdown));
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);

  const parts: MarkdownPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parts.push({ kind: 'markdown', content: markdown.slice(cursor, range.start) });
    parts.push({ kind: 'raw', content: markdown.slice(range.start, range.end) });
    cursor = range.end;
  }
  if (cursor < markdown.length || parts.length === 0) parts.push({ kind: 'markdown', content: markdown.slice(cursor) });
  return parts;
}

function slugifyMarkdownHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function markdownHeadingText(raw: string): string {
  return raw.trim().replace(/[ \t]+#+[ \t]*$/, '').trim();
}

function collectMarkdownPartHeadings(markdown: string, offset: number): Omit<MarkdownHeading, 'anchor'>[] {
  const rawLines = markdown.split('\n');
  const lines = rawLines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
  const headings: Omit<MarkdownHeading, 'anchor'>[] = [];
  const starts: number[] = [];
  let cursor = 0;
  let fence: { marker: string; length: number } | null = null;

  rawLines.forEach((line) => {
    starts.push(cursor);
    cursor += line.length + 1;
  });

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (openingFence && !(openingFence[1][0] === '`' && openingFence[2].includes('`'))) {
      fence = { marker: openingFence[1][0], length: openingFence[1].length };
      continue;
    }

    const atxMatch = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)$/);
    if (atxMatch) {
      const text = markdownHeadingText(atxMatch[2]);
      if (text.length > 0) {
        headings.push({
          depth: atxMatch[1].length,
          start: offset + starts[index],
          end: offset + starts[index] + line.length,
          text,
        });
      }
      continue;
    }

    const underline = lines[index + 1]?.trim();
    if (
      line.trim().length > 0 &&
      !/^ {4,}/.test(line) &&
      !/^ {0,3}(?:>|[-*+][ \t]|\d+[.)][ \t])/.test(line) &&
      underline &&
      /^ {0,3}(=+|-+)[ \t]*$/.test(lines[index + 1])
    ) {
      headings.push({
        depth: underline.startsWith('=') ? 1 : 2,
        start: offset + starts[index],
        end: offset + starts[index + 1] + lines[index + 1].length,
        text: line.trim(),
      });
      index += 1;
    }
  }

  return headings;
}

export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: Omit<MarkdownHeading, 'anchor'>[] = [];
  let offset = 0;

  splitUnsupportedBlocks(markdown).forEach((part) => {
    if (part.kind === 'markdown') headings.push(...collectMarkdownPartHeadings(part.content, offset));
    offset += part.content.length;
  });

  const collisions = new Map<string, number>();
  return headings.map((heading) => {
    const base = slugifyMarkdownHeading(heading.text);
    const count = (collisions.get(base) ?? 0) + 1;
    collisions.set(base, count);
    return {
      ...heading,
      anchor: count === 1 ? base : `${base}-${count}`,
    };
  });
}

function insertBlockMarkdown(markdown: string, selection: Selection, block: string): { markdown: string; selection: Selection } {
  const before = markdown.slice(0, selection.start);
  const after = markdown.slice(selection.end);
  const prefix = before.length > 0 && !before.endsWith('\n\n') ? '\n\n' : '';
  const suffix = after.length > 0 && !after.startsWith('\n\n') ? '\n\n' : '';
  const inserted = `${prefix}${block}${suffix}`;
  const cursor = before.length + prefix.length + block.length;
  return {
    markdown: `${before}${inserted}${after}`,
    selection: { start: cursor, end: cursor },
  };
}

function replaceMarkdownSelection(markdown: string, selection: Selection, replacement: string): { markdown: string; selection: Selection } {
  const before = markdown.slice(0, selection.start);
  const after = markdown.slice(selection.end);
  const cursor = before.length + replacement.length;
  return { markdown: `${before}${replacement}${after}`, selection: { start: cursor, end: cursor } };
}

function inlineCommandMarkdown(command: MarkdownAuthoringCommand, selected: string): string | null {
  const text = selected || command.markdown.replace(/^([*_~`]+)|([*_~`]+)$/g, '');
  switch (command.id) {
    case 'bold': return `**${text}**`;
    case 'italic': return `*${text}*`;
    case 'strikethrough': return `~~${text}~~`;
    case 'inline-code': return `\`${text}\``;
    case 'link': return `[${selected || 'link text'}](https://)`;
    case 'clear-formatting': return selected.replace(/^(\*\*|__|~~|`|\*|_)([\s\S]*?)\1$/, '$2') || command.markdown;
    default: return null;
  }
}

function currentLineSelection(markdown: string, selection: Selection): Selection {
  const start = markdown.lastIndexOf('\n', Math.max(0, selection.start - 1)) + 1;
  const newline = markdown.indexOf('\n', selection.end);
  return { start, end: newline === -1 ? markdown.length : newline };
}

function plainBlockText(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^- \[[ xX]\]\s+/, '')
    .replace(/^(?:[-*+]\s+|\d+\.\s+)/, '')
    .replace(/^(\*\*|__|~~|`)([\s\S]*?)\1$/, '$2');
}

function blockCommandMarkdown(command: MarkdownAuthoringCommand, line: string): string {
  const text = plainBlockText(line) || command.markdown;
  switch (command.id) {
    case 'paragraph': return plainBlockText(line) || command.markdown;
    case 'heading-1': return `# ${plainBlockText(line) || 'Heading'}`;
    case 'quote': return `> ${plainBlockText(line) || 'Quote'}`;
    case 'callout-note': return `> [!NOTE]\n> ${plainBlockText(line) || 'Callout'}`;
    case 'callout-tip': return `> [!TIP]\n> ${plainBlockText(line) || 'Callout'}`;
    case 'callout-warning': return `> [!WARNING]\n> ${plainBlockText(line) || 'Callout'}`;
    case 'bullet-list': return `- ${plainBlockText(line) || 'Item'}`;
    case 'ordered-list': return `1. ${plainBlockText(line) || 'Item'}`;
    case 'task-list': return `- [ ] ${plainBlockText(line) || 'Task'}`;
    case 'code-block': return `\`\`\`\n${plainBlockText(line) || 'code'}\n\`\`\``;
    case 'horizontal-rule': return '---';
    default: return text;
  }
}

function transformMarkdownCommand(markdown: string, selection: Selection, command: MarkdownAuthoringCommand): { markdown: string; selection: Selection } {
  const selected = markdown.slice(selection.start, selection.end);
  if (command.id === 'clear-formatting') {
    const lineSelection = currentLineSelection(markdown, selection);
    return replaceMarkdownSelection(markdown, lineSelection, plainBlockText(markdown.slice(lineSelection.start, lineSelection.end)) || command.markdown);
  }
  const inline = inlineCommandMarkdown(command, selected);
  if (inline !== null) return replaceMarkdownSelection(markdown, selection, inline);
  const lineSelection = currentLineSelection(markdown, selection);
  return replaceMarkdownSelection(markdown, lineSelection, blockCommandMarkdown(command, markdown.slice(lineSelection.start, lineSelection.end)));
}

function markdownBlocks(markdown: string): Selection[] {
  const blocks: Selection[] = [];
  let start = 0;
  const separator = /\n{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(markdown))) {
    if (match.index > start) blocks.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  if (start < markdown.length) blocks.push({ start, end: markdown.length });
  return blocks;
}

function selectionBlock(editable: HTMLElement, node: Node): HTMLElement | null {
  let element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  while (element && element.parentElement !== editable) element = element.parentElement;
  return element;
}

function domTextOffset(block: HTMLElement, node: Node, offset: number): number | null {
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

type MarkdownTextMap = { text: string; positions: number[]; hasExactSourceBoundaries: boolean };

function markdownTextMap(markdown: string): MarkdownTextMap {
  const positions: number[] = [];
  const text: string[] = [];
  let hasExactSourceBoundaries = true;

  const findToken = (start: number, end: number, token: string): number => {
    for (let index = start; index <= end - token.length; index += 1) {
      if (markdown[index] !== '\\' && markdown.slice(index, index + token.length) === token) return index;
    }
    return -1;
  };
  const findClosingBracket = (start: number, end: number): number => {
    let depth = 0;
    for (let index = start; index < end; index += 1) {
      if (markdown[index] === '\\') { index += 1; continue; }
      if (markdown[index] === '[') depth += 1;
      if (markdown[index] === ']') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  };
  const findClosingParen = (start: number, end: number): number => {
    let depth = 0;
    for (let index = start; index < end; index += 1) {
      if (markdown[index] === '\\') { index += 1; continue; }
      if (markdown[index] === '(') depth += 1;
      if (markdown[index] === ')') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  };
  const append = (index: number) => {
    positions.push(index);
    text.push(markdown[index]);
  };
  const visit = (start: number, end: number) => {
    let index = start;
    let lineStart = true;
    while (index < end) {
      if (lineStart) {
        const prefix = markdown.slice(index, end).match(/^(?: {0,3}>\s?| {0,3}#{1,6}\s+| {0,3}- \[[ xX]\]\s+| {0,3}(?:[-*+]\s+|\d+\.\s+))/)?.[0];
        if (prefix) {
          index += prefix.length;
          lineStart = false;
          continue;
        }
      }
      if (markdown[index] === '\n') {
        append(index);
        lineStart = true;
        index += 1;
        continue;
      }
      lineStart = false;
      if (markdown[index] === '\\' && index + 1 < end) {
        hasExactSourceBoundaries = false;
        append(index + 1);
        index += 2;
        continue;
      }
      if (markdown[index] === '!' && markdown[index + 1] === '[') {
        const labelEnd = findClosingBracket(index + 1, end);
        const destinationEnd = labelEnd !== -1 && markdown[labelEnd + 1] === '('
          ? findClosingParen(labelEnd + 1, end)
          : -1;
        if (destinationEnd !== -1) {
          index = destinationEnd + 1;
          continue;
        }
      }
      if (markdown[index] === '[') {
        const labelEnd = findClosingBracket(index, end);
        const destinationEnd = labelEnd !== -1 && markdown[labelEnd + 1] === '('
          ? findClosingParen(labelEnd + 1, end)
          : -1;
        if (destinationEnd !== -1) {
          visit(index + 1, labelEnd);
          index = destinationEnd + 1;
          continue;
        }
      }
      const marker = ['**', '__', '~~', '`', '*', '_'].find((candidate) => markdown.startsWith(candidate, index));
      if (marker) {
        const closing = findToken(index + marker.length, end, marker);
        if (closing !== -1) {
          visit(index + marker.length, closing);
          index = closing + marker.length;
          continue;
        }
      }
      append(index);
      index += 1;
    }
  };

  visit(0, markdown.length);
  return { text: text.join(''), positions, hasExactSourceBoundaries };
}

function markdownOffsetForVisibleText(block: string, visibleOffset: number): number {
  const positions = markdownTextMap(block).positions;
  if (visibleOffset < positions.length) return positions[visibleOffset];
  return positions.at(-1) !== undefined ? positions.at(-1)! + 1 : block.length;
}

function markdownOffsetAfterVisibleText(block: string, visibleOffset: number): number {
  const positions = markdownTextMap(block).positions;
  if (visibleOffset === 0) return positions[0] ?? 0;
  return positions[visibleOffset - 1] !== undefined ? positions[visibleOffset - 1] + 1 : block.length;
}

function visibleOffsetForMarkdown(block: string, markdownOffset: number): number {
  const positions = markdownTextMap(block).positions;
  const index = positions.findIndex((position) => position >= markdownOffset);
  return index === -1 ? positions.length : index;
}

function renderedBlockText(block: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(block);
  return range.toString();
}

function domTextPoint(block: HTMLElement, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let remaining = offset;
  let last: Text | null = null;
  while (node) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    last = node;
    node = walker.nextNode() as Text | null;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

function restoreLiveMarkdownSelection(editable: HTMLElement, markdown: string, selection: Selection): boolean {
  const blocks = markdownBlocks(markdown);
  const blockIndex = blocks.findIndex((block) => selection.start >= block.start && selection.end <= block.end);
  const markdownBlock = blocks[blockIndex];
  const domBlock = editable.children[blockIndex] as HTMLElement | undefined;
  if (!markdownBlock || !domBlock) return false;
  const source = markdown.slice(markdownBlock.start, markdownBlock.end);
  const start = domTextPoint(domBlock, visibleOffsetForMarkdown(source, selection.start - markdownBlock.start));
  const end = domTextPoint(domBlock, visibleOffsetForMarkdown(source, selection.end - markdownBlock.start));
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const domSelection = window.getSelection();
  domSelection?.removeAllRanges();
  domSelection?.addRange(range);
  return true;
}

function liveMarkdownSelection(editable: HTMLElement, markdown: string): Selection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editable.contains(range.startContainer) || !editable.contains(range.endContainer)) return null;
  const startBlock = selectionBlock(editable, range.startContainer);
  const endBlock = selectionBlock(editable, range.endContainer);
  if (!startBlock || startBlock !== endBlock) return null;
  const domBlocks = Array.from(editable.children);
  const blockIndex = domBlocks.indexOf(startBlock);
  const markdownBlock = markdownBlocks(markdown)[blockIndex];
  const start = domTextOffset(startBlock, range.startContainer, range.startOffset);
  const end = domTextOffset(endBlock, range.endContainer, range.endOffset);
  if (!markdownBlock || start === null || end === null) return null;
  const source = markdown.slice(markdownBlock.start, markdownBlock.end);
  const textMap = markdownTextMap(source);
  if (!textMap.hasExactSourceBoundaries || textMap.text !== renderedBlockText(startBlock)) return null;
  const startOffset = markdownOffsetForVisibleText(source, start);
  return {
    start: markdownBlock.start + startOffset,
    end: markdownBlock.start + (range.collapsed ? startOffset : markdownOffsetAfterVisibleText(source, end)),
  };
}

type LiveWikilinkTrigger = { query: string; selection: Selection; caret: DOMRect };

// A `[[query` typed before a collapsed caret, mapped to its Markdown range so
// the picked link can replace it. Null inside code or when the rendered text
// cannot be mapped back to the Markdown source exactly.
function liveWikilinkTrigger(editable: HTMLElement, markdown: string): LiveWikilinkTrigger | null {
  const domSelection = window.getSelection();
  if (!domSelection?.rangeCount || !domSelection.isCollapsed) return null;
  const range = domSelection.getRangeAt(0);
  if (!editable.contains(range.startContainer)) return null;
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (element?.closest('code, pre')) return null;
  const block = selectionBlock(editable, range.startContainer);
  if (!block) return null;
  const caret = domTextOffset(block, range.startContainer, range.startOffset);
  if (caret === null) return null;
  const text = renderedBlockText(block);
  const match = /\[\[([^[\]\n]{0,80})$/.exec(text.slice(0, caret));
  if (!match) return null;
  const markdownBlock = markdownBlocks(markdown)[Array.from(editable.children).indexOf(block)];
  if (!markdownBlock) return null;
  const source = markdown.slice(markdownBlock.start, markdownBlock.end);
  // The live editor exports a typed `[` as `\[`, so boundaries are not exact;
  // the visible text must still match for the offsets to be trusted.
  if (markdownTextMap(source).text !== text) return null;
  let start = markdownOffsetForVisibleText(source, caret - match[0].length);
  if (source[start - 1] === '\\') start -= 1;
  const rect = range.getBoundingClientRect();
  return {
    query: match[1],
    selection: {
      start: markdownBlock.start + start,
      end: markdownBlock.start + markdownOffsetForVisibleText(source, caret),
    },
    caret: rect.height > 0 || rect.width > 0 ? rect : block.getBoundingClientRect(),
  };
}

function tableFromNode(node: Node | null): HTMLTableElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest('table') as HTMLTableElement | null;
}

function liveTableSelection(editable: HTMLElement, container: HTMLElement, markdown: string): Selection | null {
  const domSelection = window.getSelection();
  const table = tableFromNode(domSelection?.anchorNode ?? document.activeElement);
  if (!table || !container.contains(table)) return null;
  const tableIndex = Array.from(container.querySelectorAll('table')).indexOf(table);
  const range = findMarkdownTableRanges(markdown)[tableIndex];
  return range ? { start: range.start, end: range.end } : null;
}

function liveSelectionForMarkdown(editable: HTMLElement, markdown: string, container = editable): Selection | null {
  return liveTableSelection(editable, container, markdown) ?? liveMarkdownSelection(editable, markdown);
}

export const MarkdownAuthoringEditor = forwardRef<
  MarkdownAuthoringEditorHandle,
  MarkdownAuthoringEditorProps
>(function MarkdownAuthoringEditor({ value, onChange, universeId, entryId, disabled = false }, ref) {
  const [mode, setMode] = useState<'live' | 'source'>('live');
  const [liveParserError, setLiveParserError] = useState<string | null>(null);
  const [tableSelection, setTableSelection] = useState<Selection | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkDialogInitial, setLinkDialogInitial] = useState<{
    kind: MarkdownLinkKind;
    target: string;
    label: string;
  }>({ kind: 'external', target: '', label: 'Link' });
  const mdxEditorRefs = useRef<Array<MDXEditorMethods | null>>([]);
  const liveEditorWrappers = useRef<Array<HTMLDivElement | null>>([]);
  const activeLiveEditorIndex = useRef(0);
  const restoreLiveFocus = useRef(false);
  const liveSelectionRange = useRef<Range | null>(null);
  const liveEditorContainerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const paletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const paletteOriginRef = useRef<{
    mode: 'live' | 'source'; element: HTMLElement; range: Range | null;
    markdown?: string; selection?: Selection;
  } | null>(null);
  const activeRawBlockIndex = useRef<number | null>(null);
  const latestMarkdown = useRef(value);
  const sourceSelection = useRef<Selection>({ start: 0, end: 0 });
  const linkOrigin = useRef<{
    mode: 'source' | 'live';
    index: number;
    selection: Selection;
    element: HTMLElement;
    range: Range | null;
    markdown?: string;
  } | null>(null);
  const pendingHeadingAnchor = useRef<string | null>(null);
  const [wikilink, setWikilink] = useState<{
    index: number; query: string; selection: Selection; anchor: { top: number; left: number };
  } | null>(null);
  const [wikilinkActiveIndex, setWikilinkActiveIndex] = useState(0);
  const wikilinkResultCount = useRef(0);
  const wikilinkActiveInsert = useRef<string | null>(null);
  // Escape closes the picker for this `[[` only; typing elsewhere re-arms it.
  const dismissedWikilinkStart = useRef<number | null>(null);
  const parts = splitUnsupportedBlocks(value);
  const frontmatter = parseMarkdownFrontmatter(value);
  const rawFallback = liveParserError !== null || frontmatter.diagnostics.length > 0;

  const applyLiveHeadingAnchors = () => {
    const container = liveEditorContainerRef.current;
    if (!container || rawFallback) {
      pendingHeadingAnchor.current = null;
      return;
    }

    const headings = extractMarkdownHeadings(value);
    const renderedHeadings = Array.from(
      container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'),
    );
    renderedHeadings.forEach((heading, index) => {
      const anchor = headings[index]?.anchor;
      if (!anchor) {
        if (heading.dataset.markdownAnchor) {
          heading.removeAttribute('id');
          delete heading.dataset.markdownAnchor;
        }
        return;
      }
      if (heading.id !== anchor) heading.id = anchor;
      heading.dataset.markdownAnchor = 'true';
    });

    const pending = pendingHeadingAnchor.current;
    if (!pending) return;
    const target = renderedHeadings.find((heading) => heading.id === pending);
    if (!target) return;
    pendingHeadingAnchor.current = null;
    target.scrollIntoView({ block: 'nearest' });
  };

  useEffect(() => {
    if (value === latestMarkdown.current) return;
    latestMarkdown.current = value;
    setLiveParserError(null);
    parts.forEach((part, index) => {
      if (part.kind === 'markdown') mdxEditorRefs.current[index]?.setMarkdown(part.content);
    });
  }, [value, parts]);

  useEffect(() => {
    if (mode === 'source') {
      const source = sourceRef.current;
      if (!source) return;
      source.focus();
      const selection = sourceSelection.current;
      source.setSelectionRange(selection.start, selection.end);
      setTableSelection(selection);
      return;
    }
    if (restoreLiveFocus.current) {
      mdxEditorRefs.current[activeLiveEditorIndex.current]?.focus();
      liveEditorWrappers.current[activeLiveEditorIndex.current]
        ?.querySelector<HTMLElement>('[contenteditable="true"]')
        ?.focus();
      const range = liveSelectionRange.current;
      if (range?.commonAncestorContainer.isConnected) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      restoreLiveFocus.current = false;
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'live' || rawFallback) return;
    const updateLiveSurface = () => {
      liveEditorContainerRef.current
        ?.querySelector<HTMLElement>('[contenteditable="true"]')
        ?.setAttribute('aria-label', 'Entry body');
      applyLiveHeadingAnchors();
    };
    updateLiveSurface();
    const observer = new MutationObserver(updateLiveSurface);
    const container = liveEditorContainerRef.current;
    if (container) observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [mode, rawFallback, value]);

  const changeLivePart = (index: number, markdown: string) => {
    const canonicalMarkdown = canonicalizeLiveMarkdown(markdown, parts[index]?.content);
    const next = parts.map((part, partIndex) => partIndex === index ? { ...part, content: canonicalMarkdown } : part)
      .map((part) => part.content)
      .join('');
    latestMarkdown.current = next;
    onChange(next);
  };

  const updateWikilink = () => {
    const index = activeLiveEditorIndex.current;
    const wrapper = liveEditorWrappers.current[index];
    const editable = wrapper?.querySelector<HTMLElement>('[contenteditable="true"]');
    const editor = mdxEditorRefs.current[index];
    const trigger = mode === 'live' && !disabled && wrapper && editable && editor
      ? liveWikilinkTrigger(editable, editor.getMarkdown())
      : null;
    if (!trigger || trigger.selection.start !== dismissedWikilinkStart.current) dismissedWikilinkStart.current = null;
    if (!trigger || dismissedWikilinkStart.current !== null) {
      setWikilink((current) => current === null ? current : null);
      return;
    }
    const box = wrapper!.getBoundingClientRect();
    const anchor = { top: trigger.caret.bottom - box.top, left: trigger.caret.left - box.left };
    setWikilink((current) => {
      if (current && current.index === index && current.query === trigger.query
        && current.selection.start === trigger.selection.start && current.selection.end === trigger.selection.end
        && current.anchor.top === anchor.top && current.anchor.left === anchor.left) return current;
      if (current?.query !== trigger.query) setWikilinkActiveIndex(0);
      return { index, query: trigger.query, selection: trigger.selection, anchor };
    });
  };

  const insertWikilink = (insertText: string) => {
    const target = wikilink;
    if (!target) return;
    setWikilink(null);
    const editor = mdxEditorRefs.current[target.index];
    const editable = liveEditorWrappers.current[target.index]?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor) return;
    const replaced = replaceMarkdownSelection(editor.getMarkdown(), target.selection, insertText);
    const canonical = canonicalizeLiveMarkdown(replaced.markdown, parts[target.index]?.content);
    editor.setMarkdown(canonical);
    changeLivePart(target.index, canonical);
    requestAnimationFrame(() => {
      if (!editable?.isConnected) return;
      editable.focus();
      restoreLiveMarkdownSelection(editable, canonical, replaced.selection);
    });
  };

  const handleWikilinkKey = (event: React.KeyboardEvent) => {
    if (!wikilink) return;
    const count = wikilinkResultCount.current;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (count === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : count - 1;
      setWikilinkActiveIndex((index) => (index + step) % count);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      const insertText = wikilinkActiveInsert.current;
      if (!insertText) return;
      event.preventDefault();
      event.stopPropagation();
      insertWikilink(insertText);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismissedWikilinkStart.current = wikilink.selection.start;
      setWikilink(null);
    }
  };

  const switchMode = (nextMode: 'live' | 'source') => {
    setWikilink(null);
    if (nextMode === 'source') {
      const liveIndex = activeLiveEditorIndex.current;
      const activeElement = liveEditorWrappers.current[liveIndex]
        ?.querySelector<HTMLElement>('[contenteditable="true"]');
      restoreLiveFocus.current = activeElement === document.activeElement;
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      liveSelectionRange.current = range && liveEditorContainerRef.current?.contains(range.commonAncestorContainer)
        ? range.cloneRange()
        : null;
      const editor = mdxEditorRefs.current[liveIndex];
      const markdown = parts[liveIndex]?.content ?? editor?.getMarkdown() ?? '';
      const liveSelection = activeElement
        ? liveSelectionForMarkdown(activeElement, markdown, liveEditorWrappers.current[liveIndex] ?? activeElement)
        : null;
      if (liveSelection) {
        const offset = parts.slice(0, liveIndex).reduce((total, part) => total + part.content.length, 0);
        sourceSelection.current = {
          start: liveSelection.start + offset,
          end: liveSelection.end + offset,
        };
        setTableSelection(sourceSelection.current);
      }
    } else {
      restoreLiveFocus.current = true;
    }
    setMode(nextMode);
  };

  const capturePaletteOrigin = (trigger?: HTMLElement) => {
    if (mode === 'source') {
      const source = sourceRef.current;
      if (source) {
        sourceSelection.current = { start: source.selectionStart, end: source.selectionEnd };
        paletteOriginRef.current = { mode: 'source', element: source, range: null };
        paletteReturnFocusRef.current = source;
        return;
      }
    }
    const editable = liveEditorWrappers.current[activeLiveEditorIndex.current]
      ?.querySelector<HTMLElement>('[contenteditable="true"]');
    const selection = window.getSelection();
    const range = selection?.rangeCount && editable?.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).cloneRange()
      : null;
    if (editable) {
      paletteOriginRef.current = { mode: 'live', element: editable, range };
      paletteReturnFocusRef.current = editable;
      return;
    }
    paletteReturnFocusRef.current = trigger ?? null;
  };

  const restorePaletteOrigin = () => {
    const origin = paletteOriginRef.current;
    if (!origin?.element.isConnected) {
      paletteReturnFocusRef.current?.focus();
      return;
    }
    origin.element.focus();
    if (origin.mode === 'source') {
      const source = origin.element as HTMLTextAreaElement;
      source.setSelectionRange(sourceSelection.current.start, sourceSelection.current.end);
      return;
    }
    if (origin.markdown && origin.selection && restoreLiveMarkdownSelection(origin.element, origin.markdown, origin.selection)) return;
    if (origin.range?.commonAncestorContainer.isConnected) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(origin.range);
    }
  };

  const insertMarkdown = (markdown: string) => {
    if (disabled) return;
    if (mode === 'source') {
      const inserted = insertBlockMarkdown(latestMarkdown.current, sourceSelection.current, markdown);
      sourceSelection.current = inserted.selection;
      latestMarkdown.current = inserted.markdown;
      onChange(inserted.markdown);
      return;
    }

    const editor = mdxEditorRefs.current[activeLiveEditorIndex.current];
    if (editor && !rawFallback) {
      editor.insertMarkdown(`\n\n${markdown}\n\n`);
      return;
    }

    const inserted = insertBlockMarkdown(latestMarkdown.current, sourceSelection.current, markdown);
    sourceSelection.current = inserted.selection;
    latestMarkdown.current = inserted.markdown;
    onChange(inserted.markdown);
  };

  const navigateToHeading = (anchor: string) => {
    if (disabled) return;
    pendingHeadingAnchor.current = anchor;
    if (mode !== 'live') {
      switchMode('live');
      return;
    }
    applyLiveHeadingAnchors();
  };

  const revealSelection = (selection: Selection) => {
    if (disabled) return;
    sourceSelection.current = selection;
    setTableSelection(selection);
    if (mode !== 'source') {
      switchMode('source');
      return;
    }
    const source = sourceRef.current;
    if (!source) return;
    source.focus();
    source.setSelectionRange(selection.start, selection.end);
  };

  const replaceSelection = (selection: Selection, markdown: string) => {
    if (disabled) return;
    const replaced = replaceMarkdownSelection(latestMarkdown.current, selection, markdown);
    latestMarkdown.current = replaced.markdown;
    sourceSelection.current = replaced.selection;
    setLiveParserError(null);
    setTableSelection(replaced.selection);
    onChange(replaced.markdown);
    if (mode !== 'source') {
      switchMode('source');
      return;
    }
    const source = sourceRef.current;
    if (!source) return;
    source.focus();
    source.setSelectionRange(replaced.selection.start, replaced.selection.end);
  };

  const openLinkDialog = () => {
    if (disabled) return;
    if (mode === 'source') {
      const source = sourceRef.current;
      const selection = source
        ? { start: source.selectionStart, end: source.selectionEnd }
        : sourceSelection.current;
      sourceSelection.current = selection;
      const selected = latestMarkdown.current.slice(selection.start, selection.end);
      const parsed = parseMarkdownLink(selected);
      if (!source) return;
      linkOrigin.current = { mode: 'source', index: 0, selection, element: source, range: null, markdown: latestMarkdown.current };
      setLinkDialogInitial(parsed ?? { kind: 'external', target: '', label: selected || 'Link' });
      setLinkDialogOpen(true);
      return;
    }

    const index = activeLiveEditorIndex.current;
    const editor = mdxEditorRefs.current[index];
    const editable = liveEditorWrappers.current[index]?.querySelector<HTMLElement>('[contenteditable="true"]');
    const markdown = editor?.getMarkdown() ?? parts[index]?.content ?? '';
    const selection = editable ? liveMarkdownSelection(editable, markdown) : null;
    if (!editor || !editable || !selection) return;
    const selected = markdown.slice(selection.start, selection.end);
    const parsed = parseMarkdownLink(selected);
    const domSelection = window.getSelection();
    const range = domSelection?.rangeCount && editable.contains(domSelection.getRangeAt(0).commonAncestorContainer)
      ? domSelection.getRangeAt(0).cloneRange()
      : null;
    linkOrigin.current = { mode: 'live', index, selection, element: editable, range, markdown };
    setLinkDialogInitial(parsed ?? { kind: 'external', target: '', label: selected || 'Link' });
    setLinkDialogOpen(true);
  };

  const restoreLinkOrigin = () => {
    const origin = linkOrigin.current;
    if (!origin?.element.isConnected) return;
    origin.element.focus();
    if (origin.mode === 'source') {
      const source = origin.element as HTMLTextAreaElement;
      source.setSelectionRange(origin.selection.start, origin.selection.end);
      sourceSelection.current = origin.selection;
      return;
    }
    if (origin.markdown && restoreLiveMarkdownSelection(origin.element, origin.markdown, origin.selection)) return;
    if (origin.range?.commonAncestorContainer.isConnected) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(origin.range);
    }
  };

  const replaceLinkSelection = (markdown: string) => {
    const origin = linkOrigin.current;
    if (!origin) {
      insertMarkdown(markdown);
      return;
    }
    if (origin.mode === 'source') {
      const replaced = replaceMarkdownSelection(latestMarkdown.current, origin.selection, markdown);
      sourceSelection.current = replaced.selection;
      latestMarkdown.current = replaced.markdown;
      origin.selection = replaced.selection;
      origin.markdown = replaced.markdown;
      onChange(replaced.markdown);
      return;
    }
    const editor = mdxEditorRefs.current[origin.index];
    const current = editor?.getMarkdown() ?? parts[origin.index]?.content ?? '';
    const replaced = replaceMarkdownSelection(current, origin.selection, markdown);
    const canonical = canonicalizeLiveMarkdown(replaced.markdown, parts[origin.index]?.content);
    origin.selection = replaced.selection;
    origin.markdown = canonical;
    editor?.setMarkdown(canonical);
    changeLivePart(origin.index, canonical);
  };

  const executeCommand = (commandId: MarkdownAuthoringCommandId) => {
    if (disabled) return;
    if (commandId === 'link') {
      openLinkDialog();
      return;
    }
    const command = markdownAuthoringCommands.find(({ id }) => id === commandId);
    if (!command) return;
    if (mode === 'source') {
      const transformed = transformMarkdownCommand(latestMarkdown.current, sourceSelection.current, command);
      sourceSelection.current = transformed.selection;
      latestMarkdown.current = transformed.markdown;
      onChange(transformed.markdown);
      return;
    }

    if (rawFallback || activeRawBlockIndex.current !== null) return;
    const index = activeLiveEditorIndex.current;
    const editor = mdxEditorRefs.current[index];
    const editable = liveEditorWrappers.current[index]?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editor && editable) {
      const markdown = editor.getMarkdown();
      const selection = liveMarkdownSelection(editable, markdown);
      if (!selection) return;
      const transformed = transformMarkdownCommand(markdown, selection, command);
      const paletteOrigin = paletteOriginRef.current;
      if (paletteOrigin?.mode === 'live' && paletteOrigin.element === editable) {
        paletteOrigin.markdown = transformed.markdown;
        paletteOrigin.selection = transformed.selection;
        paletteOrigin.range = null;
      }
      window.getSelection()?.removeAllRanges();
      editor.setMarkdown(transformed.markdown);
      changeLivePart(index, transformed.markdown);
      return;
    }
  };

  useImperativeHandle(
    ref,
    () => ({ insertMarkdown, executeCommand, navigateToHeading, revealSelection, replaceSelection }),
    [insertMarkdown, executeCommand, navigateToHeading, revealSelection, replaceSelection],
  );

  const getTableSelection = (liveIndex = activeLiveEditorIndex.current) => {
    if (mode === 'source') {
      const source = sourceRef.current;
      return source
        ? { start: source.selectionStart, end: source.selectionEnd }
        : sourceSelection.current;
    }
    if (rawFallback || activeRawBlockIndex.current !== null) return null;
    const editor = mdxEditorRefs.current[liveIndex];
    const editable = liveEditorWrappers.current[liveIndex]?.querySelector<HTMLElement>('[contenteditable="true"]');
    const markdown = parts[liveIndex]?.content ?? editor?.getMarkdown() ?? '';
    const selection = editable
      ? liveSelectionForMarkdown(editable, markdown, liveEditorWrappers.current[liveIndex] ?? editable)
      : null;
    if (!selection) return null;
    const offset = parts.slice(0, liveIndex).reduce((total, part) => total + part.content.length, 0);
    return { start: selection.start + offset, end: selection.end + offset };
  };

  const updateTableSelection = (liveIndex = activeLiveEditorIndex.current) => {
    const next = getTableSelection(liveIndex);
    setTableSelection((current) => sameSelection(current, next) ? current : next);
  };

  useEffect(() => {
    if (mode !== 'live') return;
    const handleSelectionChange = () => {
      updateTableSelection();
      updateWikilink();
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    updateTableSelection();
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [mode, rawFallback, value]);

  let partOffset = 0;

  return (
    <section
      className="markdown-authoring-surface rounded-md border border-line-strong bg-canvas-lo text-ink"
      role="region"
      aria-label="Markdown authoring editor"
      onKeyDown={(event) => {
        if (disabled) return;
        if (!(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === 'p' && event.shiftKey) {
          event.preventDefault();
          capturePaletteOrigin(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
          setPaletteOpen(true);
          return;
        }
        const command = key === 'b' ? 'bold'
          : key === 'i' ? 'italic'
            : key === 'k' ? 'link'
              : undefined;
        if (command) {
          event.preventDefault();
          executeCommand(command);
        }
      }}
    >
      <MarkdownAuthoringToolbar
        commands={markdownAuthoringCommands}
        disabled={disabled}
        onCommand={executeCommand}
        onLink={openLinkDialog}
        onOpenPalette={(trigger) => {
          if (disabled) return;
          capturePaletteOrigin(trigger);
          setPaletteOpen(true);
        }}
      />
      <div className="flex items-center justify-end gap-1 border-b px-2 py-1 border-line" role="group" aria-label="Editor mode">
        <button
          type="button"
          aria-pressed={mode === 'live'}
          onClick={() => switchMode('live')}
          className="rounded px-2 py-1 text-xs data-[state=active]:bg-white/5"
          data-state={mode === 'live' ? 'active' : 'inactive'}
        >
          Live Preview
        </button>
        <button
          type="button"
          aria-pressed={mode === 'source'}
          onClick={() => switchMode('source')}
          className="rounded px-2 py-1 text-xs data-[state=active]:bg-white/5"
          data-state={mode === 'source' ? 'active' : 'inactive'}
        >
          Source
        </button>
      </div>
      <MarkdownFrontmatterPanel
        markdown={value}
        disabled={disabled}
        onChange={(markdown) => {
          latestMarkdown.current = markdown;
          onChange(markdown);
        }}
        onEditInSource={() => switchMode('source')}
      />

      <div hidden={mode !== 'live'} aria-hidden={mode !== 'live'}>
        {rawFallback ? (
          <pre
            tabIndex={0}
            onFocus={() => { activeRawBlockIndex.current = 0; sourceSelection.current = { start: value.length, end: value.length }; setTableSelection(null); }}
            onClick={() => { activeRawBlockIndex.current = 0; sourceSelection.current = { start: value.length, end: value.length }; setTableSelection(null); }}
            className="m-3 overflow-x-auto rounded p-3 text-sm bg-panel text-ink"
            aria-label="Raw Markdown block"
          >
            <code>{value}</code>
          </pre>
        ) : (
          <div ref={liveEditorContainerRef}>
            {parts.map((part, index) => {
              const start = partOffset;
              partOffset += part.content.length;
              return part.kind === 'raw' ? (
                <pre
                  key={`${index}-${part.content}`}
                  tabIndex={0}
                  onFocus={() => { activeRawBlockIndex.current = index; sourceSelection.current = { start: start + part.content.length, end: start + part.content.length }; setTableSelection(null); }}
                  onClick={() => { activeRawBlockIndex.current = index; sourceSelection.current = { start: start + part.content.length, end: start + part.content.length }; setTableSelection(null); }}
                  className="m-3 overflow-x-auto rounded p-3 text-sm bg-panel text-ink"
                  aria-label="Raw Markdown block"
                >
                  <code>{part.content}</code>
                </pre>
              ) : (
                <div
                  key={index}
                  ref={(element) => { liveEditorWrappers.current[index] = element; }}
                  className="relative"
                  onFocusCapture={() => { activeRawBlockIndex.current = null; activeLiveEditorIndex.current = index; updateTableSelection(index); }}
                  onKeyDownCapture={handleWikilinkKey}
                  onClick={() => { mdxEditorRefs.current[index]?.focus(); updateTableSelection(index); }}
                >
                  <MDXEditor
                    ref={(editor) => { mdxEditorRefs.current[index] = editor; }}
                    markdown={part.content}
                    plugins={editorPlugins}
                    className="markdown-authoring-editor-theme"
                    readOnly={disabled}
                    placeholder="Write in Markdown..."
                    contentEditableClassName="prose prose-neutral prose-invert max-w-none min-h-48 px-3 py-2 focus:outline-none"
                    onChange={(markdown, initialMarkdownNormalize) => {
                      if (initialMarkdownNormalize) return;
                      changeLivePart(index, markdown);
                      requestAnimationFrame(updateWikilink);
                    }}
                    onError={({ error }) => setLiveParserError(error)}
                  />
                  {wikilink?.index === index && (
                    <WikilinkAutocomplete
                      universeId={universeId}
                      currentEntryId={entryId ?? null}
                      query={wikilink.query}
                      triggerStart={wikilink.selection.start}
                      anchor={wikilink.anchor}
                      activeIndex={wikilinkActiveIndex}
                      onActiveIndexChange={setWikilinkActiveIndex}
                      onResultCountChange={(count) => { wikilinkResultCount.current = count; }}
                      onActiveInsertChange={(insertText) => { wikilinkActiveInsert.current = insertText; }}
                      onSelect={insertWikilink}
                      onDismiss={() => setWikilink(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <MarkdownTableControls
        markdown={value}
        disabled={disabled}
        selection={tableSelection}
        getSelection={getTableSelection}
        onChange={(markdown) => {
          latestMarkdown.current = markdown;
          onChange(markdown);
        }}
      />

      {mode === 'source' && (
        <textarea
          ref={sourceRef}
          aria-label="Entry body"
          rows={12}
          value={value}
          disabled={disabled}
          onSelect={(event) => {
            const selection = {
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            };
            sourceSelection.current = selection;
            setTableSelection(selection);
          }}
          onChange={(event) => {
            latestMarkdown.current = event.target.value;
            setLiveParserError(null);
            const selection = {
              start: event.target.selectionStart,
              end: event.target.selectionEnd,
            };
            sourceSelection.current = selection;
            setTableSelection(selection);
            onChange(event.target.value);
          }}
          className="w-full resize-y bg-transparent px-3 py-2 font-mono text-sm focus:outline-none"
        />
      )}
      <MarkdownCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={markdownAuthoringCommands}
        disabled={disabled}
        onCommand={(command) => command === 'link' ? openLinkDialog() : executeCommand(command)}
        returnFocusRef={paletteReturnFocusRef}
        onRestoreFocus={restorePaletteOrigin}
      />
      <MarkdownLinkDialog
        open={linkDialogOpen}
        onOpenChange={(open) => {
          setLinkDialogOpen(open);
          if (!open) {
            queueMicrotask(() => {
              restoreLinkOrigin();
              linkOrigin.current = null;
            });
          }
        }}
        onInsert={replaceLinkSelection}
        universeId={universeId}
        currentEntryId={entryId ?? null}
        initialKind={linkDialogInitial.kind}
        initialTarget={linkDialogInitial.target}
        initialLabel={linkDialogInitial.label}
      />
    </section>
  );
});
