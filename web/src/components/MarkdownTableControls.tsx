import type { ReactNode } from 'react';

type TableLocation = {
  start: number;
  end: number;
  rows: string[][];
  delimiter: string[];
};

export type MarkdownTableSelection = { start: number; end: number };
export type MarkdownTableRange = MarkdownTableSelection;

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const source = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailing = source.endsWith('|') ? source.slice(0, -1) : source;
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const character of withoutTrailing) {
    if (character === '|' && !escaped) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  cells.push(cell.trim());
  return cells;
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function lineStart(markdown: string, lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) offset += markdown.split('\n')[index].length + 1;
  return offset;
}

type MarkdownContainer = { kind: 'blockquote' | 'list'; length: number };
type FenceState = { marker: '`' | '~'; length: number; containers: MarkdownContainer[] };

type FenceLine = { marker: '`' | '~'; length: number; suffix: string };

type ParsedFenceLine = FenceLine & { containers: MarkdownContainer[]; indentation: number };

function parseMarkdownContainers(line: string): { rest: string; containers: MarkdownContainer[]; indentation: number } {
  let rest = line;
  const containers: MarkdownContainer[] = [];
  while (true) {
    const leading = rest.match(/^[ \t]*/)?.[0].length ?? 0;
    const content = rest.slice(leading);
    const blockquote = content.match(/^>\s?/);
    if (blockquote) {
      containers.push({ kind: 'blockquote', length: leading + blockquote[0].length });
      rest = content.slice(blockquote[0].length);
      continue;
    }
    const list = content.match(/^(?:[-+*]|\d+[.)])\s+/);
    if (list) {
      containers.push({ kind: 'list', length: leading + list[0].length });
      rest = content.slice(list[0].length);
      continue;
    }
    return { rest: rest.trimStart(), containers, indentation: leading };
  }
}

function parseFenceLine(line: string): ParsedFenceLine | null {
  const parsed = parseMarkdownContainers(line);
  const match = parsed.rest.match(/^(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return {
    marker: match[1][0] as '`' | '~',
    length: match[1].length,
    suffix: match[2],
    containers: parsed.containers,
    indentation: parsed.indentation,
  };
}

function sameContainerKinds(left: MarkdownContainer[], right: MarkdownContainer[]): boolean {
  return left.length === right.length && left.every((container, index) => container.kind === right[index].kind);
}

function containerMatches(opening: MarkdownContainer[], line: { containers: MarkdownContainer[]; indentation: number }): boolean {
  if (sameContainerKinds(opening, line.containers)) return true;
  for (let start = 0; start <= opening.length; start += 1) {
    if (!opening.slice(0, start).every((container) => container.kind === 'list')) continue;
    for (let end = start; end <= opening.length; end += 1) {
      if (!opening.slice(end).every((container) => container.kind === 'list')) continue;
      if (!sameContainerKinds(opening.slice(start, end), line.containers)) continue;
      const requiredIndentation = [...opening.slice(0, start), ...opening.slice(end)]
        .reduce((total, container) => total + container.length, 0);
      if (line.indentation >= requiredIndentation) return true;
    }
  }
  return false;
}

function fenceContainerMatches(fence: FenceState, line: ParsedFenceLine): boolean {
  return containerMatches(fence.containers, line);
}

function isTopLevelTableLine(line: string): boolean {
  if (line !== line.trimStart()) return false;
  if (line.startsWith('>')) return false;
  return !/^(?:[-+*]|\d+[.)])[ \t]/.test(line);
}

function protectedMarkdownLines(lines: string[]): boolean[] {
  const protectedLines = lines.map(() => false);
  let fence: FenceState | null = null;
  let rawDirective: MarkdownContainer[] | null = null;

  lines.forEach((line, index) => {
    const fenceLine = parseFenceLine(line);
    if (fence) {
      protectedLines[index] = true;
      if (
        fenceLine &&
        fenceLine.marker === fence.marker &&
        fenceLine.length >= fence.length &&
        fenceLine.suffix.trim() === '' &&
        fenceContainerMatches(fence, fenceLine)
      ) {
        fence = null;
      }
      return;
    }
    if (rawDirective) {
      protectedLines[index] = true;
      const parsed = parseMarkdownContainers(line);
      if (/^:::\s*$/.test(parsed.rest) && containerMatches(rawDirective, parsed)) rawDirective = null;
      return;
    }
    if (fenceLine) {
      protectedLines[index] = true;
      fence = { marker: fenceLine.marker, length: fenceLine.length, containers: fenceLine.containers };
      return;
    }
    const parsed = parseMarkdownContainers(line);
    if (/^:::\s*\S+/.test(parsed.rest)) {
      protectedLines[index] = true;
      rawDirective = parsed.containers;
    }
  });
  return protectedLines;
}

function findTables(markdown: string): TableLocation[] {
  const lines = markdown.split('\n');
  const protectedLines = protectedMarkdownLines(lines);
  const tables: TableLocation[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (protectedLines[index] || protectedLines[index + 1]) continue;
    if (!isTopLevelTableLine(lines[index]) || !isTopLevelTableLine(lines[index + 1])) continue;
    const header = splitTableRow(lines[index]);
    const delimiter = splitTableRow(lines[index + 1]);
    if (!header || !delimiter || header.length < 1 || header.length !== delimiter.length || !isDelimiterRow(delimiter)) continue;
    const rows = [header];
    let endIndex = index + 1;
    let invalid = false;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      if (protectedLines[rowIndex]) break;
      const row = splitTableRow(lines[rowIndex]);
      if (!row) break;
      if (!isTopLevelTableLine(lines[rowIndex])) {
        invalid = true;
        break;
      }
      if (row.length !== header.length) {
        invalid = true;
        break;
      }
      rows.push(row);
      endIndex = rowIndex;
    }
    if (invalid) continue;
    tables.push({
      start: lineStart(markdown, index),
      end: lineStart(markdown, endIndex) + lines[endIndex].length,
      rows,
      delimiter,
    });
    index = endIndex;
  }
  return tables;
}

function findTable(markdown: string, selection?: MarkdownTableSelection | null): TableLocation | null {
  const tables = findTables(markdown);
  if (selection === null) return null;
  if (selection) {
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    return tables.find((table) => start >= table.start && end <= table.end) ?? null;
  }
  return tables.length === 1 ? tables[0] : null;
}

export function findMarkdownTableRanges(markdown: string): MarkdownTableRange[] {
  return findTables(markdown).map(({ start, end }) => ({ start, end }));
}

function looksLikeDelimiterCell(cell: string): boolean {
  return /^:?-{1,}:?$/.test(cell) && cell.includes('-');
}

export function findMalformedMarkdownTableRanges(markdown: string): MarkdownTableRange[] {
  const lines = markdown.split('\n');
  const protectedLines = protectedMarkdownLines(lines);
  const ranges: MarkdownTableRange[] = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (protectedLines[index] || protectedLines[index + 1]) continue;
    if (!isTopLevelTableLine(lines[index]) || !isTopLevelTableLine(lines[index + 1])) continue;
    const header = splitTableRow(lines[index]);
    const delimiter = splitTableRow(lines[index + 1]);
    if (!header || !delimiter) continue;
    const validDelimiter = header.length === delimiter.length && isDelimiterRow(delimiter);
    const firstRow = index + 2 < lines.length && !protectedLines[index + 2] && isTopLevelTableLine(lines[index + 2])
      ? splitTableRow(lines[index + 2])
      : null;
    if (!firstRow) {
      if (validDelimiter) continue;
      const nextLine = index + 2 < lines.length ? lines[index + 2] : null;
      const boundary = nextLine === null || nextLine.trim() === '' || !splitTableRow(nextLine);
      if (!boundary || header.length < 2 || !delimiter.some(looksLikeDelimiterCell)) continue;
      if (!lines[index].trimStart().startsWith('|') && !lines[index + 1].trimStart().startsWith('|')) continue;
      ranges.push({
        start: lineStart(markdown, index),
        end: lineStart(markdown, index + 1) + lines[index + 1].length,
      });
      index += 1;
      continue;
    }
    let endIndex = index + 2;
    let incompatibleRow = false;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      if (protectedLines[rowIndex] || !isTopLevelTableLine(lines[rowIndex])) break;
      const row = splitTableRow(lines[rowIndex]);
      if (!row) break;
      endIndex = rowIndex;
      if (row.length !== header.length) incompatibleRow = true;
    }
    if (validDelimiter && !incompatibleRow && firstRow.length === header.length) {
      index = endIndex;
      continue;
    }
    if (validDelimiter && incompatibleRow) {
      ranges.push({
        start: lineStart(markdown, index),
        end: lineStart(markdown, endIndex) + lines[endIndex].length,
      });
      index = endIndex;
      continue;
    }
    if (header.length < 2 || !delimiter.some(looksLikeDelimiterCell)) continue;
    if (!lines[index].trimStart().startsWith('|') && !lines[index + 1].trimStart().startsWith('|')) continue;
    ranges.push({
      start: lineStart(markdown, index),
      end: lineStart(markdown, endIndex) + lines[endIndex].length,
    });
    index = endIndex;
  }

  return ranges;
}

function renderTable(location: TableLocation, rows: string[][], delimiter = location.delimiter): string {
  const lines = [rows[0], delimiter, ...rows.slice(1)];
  return lines.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function replaceTable(
  markdown: string,
  transform: (location: TableLocation) => string,
  selection?: MarkdownTableSelection | null,
): string {
  const location = findTable(markdown, selection);
  if (!location) return markdown;
  return `${markdown.slice(0, location.start)}${transform(location)}${markdown.slice(location.end)}`;
}

export function addMarkdownTableRow(markdown: string, selection?: MarkdownTableSelection | null): string {
  return replaceTable(markdown, (location) => renderTable(location, [...location.rows, Array(location.rows[0].length).fill('')]), selection);
}

export function removeMarkdownTableRow(markdown: string, selection?: MarkdownTableSelection | null): string {
  return replaceTable(markdown, (location) => location.rows.length > 1
    ? renderTable(location, location.rows.slice(0, -1))
    : renderTable(location, location.rows), selection);
}

export function addMarkdownTableColumn(markdown: string, selection?: MarkdownTableSelection | null): string {
  return replaceTable(markdown, (location) => renderTable(
    location,
    location.rows.map((row) => [...row, '']),
    [...location.delimiter, '---'],
  ), selection);
}

export function removeMarkdownTableColumn(markdown: string, selection?: MarkdownTableSelection | null): string {
  return replaceTable(markdown, (location) => location.rows[0].length > 1
    ? renderTable(location, location.rows.map((row) => row.slice(0, -1)), location.delimiter.slice(0, -1))
    : renderTable(location, location.rows), selection);
}

export function insertMarkdownTable(markdown: string): string {
  const table = '| Header 1 | Header 2 |\n| --- | --- |\n| | |';
  if (!markdown) return table;
  const separator = markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n';
  return `${markdown}${separator}${table}`;
}

export type MarkdownTableControlsProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  selection?: MarkdownTableSelection | null;
  getSelection?: () => MarkdownTableSelection | null;
  children?: ReactNode;
};

export function MarkdownTableControls({ markdown, onChange, disabled = false, selection, getSelection, children }: MarkdownTableControlsProps) {
  const selectionAtRender = selection === undefined ? (getSelection ? getSelection() : null) : selection;
  const table = findTable(markdown, selectionAtRender);
  const canRemoveRow = !!table && table.rows.length > 1;
  const canRemoveColumn = !!table && table.rows[0].length > 1;
  const action = (transform: (value: string, selection: MarkdownTableSelection) => string) => {
    if (disabled) return;
    const selection = getSelection?.() ?? selectionAtRender;
    if (!selection || !findTable(markdown, selection)) return;
    onChange(transform(markdown, selection));
  };

  return (
    <div className="flex flex-wrap items-center gap-1 border-t border-line px-2 py-1 text-xs" role="group" aria-label="Table controls">
      {children}
      <button type="button" disabled={disabled || !table} onClick={() => action(addMarkdownTableRow)} className="rounded border border-line-strong px-2 py-1 disabled:opacity-50">Add table row</button>
      <button type="button" disabled={disabled || !canRemoveRow} onClick={() => action(removeMarkdownTableRow)} className="rounded border border-line-strong px-2 py-1 disabled:opacity-50">Remove table row</button>
      <button type="button" disabled={disabled || !table} onClick={() => action(addMarkdownTableColumn)} className="rounded border border-line-strong px-2 py-1 disabled:opacity-50">Add table column</button>
      <button type="button" disabled={disabled || !canRemoveColumn} onClick={() => action(removeMarkdownTableColumn)} className="rounded border border-line-strong px-2 py-1 disabled:opacity-50">Remove table column</button>
      {!table && <button type="button" disabled={disabled} onClick={() => onChange(insertMarkdownTable(markdown))} className="rounded border border-line-strong px-2 py-1 disabled:opacity-50">Insert table</button>}
    </div>
  );
}
