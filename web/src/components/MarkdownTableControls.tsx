import type { ReactNode } from 'react';

type TableLocation = {
  start: number;
  end: number;
  rows: string[][];
  delimiter: string[];
};

export type MarkdownTableSelection = { start: number; end: number };

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

type FenceState = { marker: '`' | '~'; length: number };

function stripMarkdownContainers(line: string): string {
  let rest = line.trimStart();
  let stripped = true;
  while (stripped) {
    stripped = false;
    const blockquote = rest.match(/^>\s?/);
    if (blockquote) {
      rest = rest.slice(blockquote[0].length).trimStart();
      stripped = true;
      continue;
    }
    const list = rest.match(/^(?:[-+*]|\d+[.)])\s+/);
    if (list) {
      rest = rest.slice(list[0].length).trimStart();
      stripped = true;
    }
  }
  return rest;
}

type FenceLine = { marker: '`' | '~'; length: number; suffix: string };

function parseFenceLine(line: string): FenceLine | null {
  const rest = stripMarkdownContainers(line);
  const match = rest.match(/^(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return {
    marker: match[1][0] as '`' | '~',
    length: match[1].length,
    suffix: match[2],
  };
}

function isTopLevelTableLine(line: string): boolean {
  if (line !== line.trimStart()) return false;
  if (line.startsWith('>')) return false;
  return !/^(?:[-+*]|\d+[.)])[ \t]/.test(line);
}

function protectedMarkdownLines(lines: string[]): boolean[] {
  const protectedLines = lines.map(() => false);
  let fence: FenceState | null = null;
  let rawDirective = false;

  lines.forEach((line, index) => {
    const fenceLine = parseFenceLine(line);
    if (fence) {
      protectedLines[index] = true;
      if (fenceLine && fenceLine.marker === fence.marker && fenceLine.length >= fence.length && fenceLine.suffix.trim() === '') {
        fence = null;
      }
      return;
    }
    if (rawDirective) {
      protectedLines[index] = true;
      if (/^:::\s*$/.test(stripMarkdownContainers(line))) rawDirective = false;
      return;
    }
    if (fenceLine) {
      protectedLines[index] = true;
      fence = { marker: fenceLine.marker, length: fenceLine.length };
      return;
    }
    if (/^:::\s*\S+/.test(stripMarkdownContainers(line))) {
      protectedLines[index] = true;
      rawDirective = true;
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
      if (!row || row.length !== header.length) break;
      if (!isTopLevelTableLine(lines[rowIndex])) {
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
  const table = '| Header 1 | Header 2 |\n| --- | --- |\n|  |  |';
  if (!markdown) return table;
  const separator = markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n';
  return `${markdown}${separator}${table}`;
}

export type MarkdownTableControlsProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  disabled?: boolean;
  getSelection?: () => MarkdownTableSelection | null;
  children?: ReactNode;
};

export function MarkdownTableControls({ markdown, onChange, disabled = false, getSelection, children }: MarkdownTableControlsProps) {
  const selectionAtRender = getSelection ? getSelection() : null;
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
    <div className="flex flex-wrap items-center gap-1 border-t border-neutral-800 px-2 py-1 text-xs" role="group" aria-label="Table controls">
      {children}
      <button type="button" disabled={disabled || !table} onClick={() => action(addMarkdownTableRow)} className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-50">Add table row</button>
      <button type="button" disabled={disabled || !canRemoveRow} onClick={() => action(removeMarkdownTableRow)} className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-50">Remove table row</button>
      <button type="button" disabled={disabled || !table} onClick={() => action(addMarkdownTableColumn)} className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-50">Add table column</button>
      <button type="button" disabled={disabled || !canRemoveColumn} onClick={() => action(removeMarkdownTableColumn)} className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-50">Remove table column</button>
      {!table && <button type="button" disabled={disabled} onClick={() => onChange(insertMarkdownTable(markdown))} className="rounded border border-neutral-700 px-2 py-1 disabled:opacity-50">Insert table</button>}
    </div>
  );
}
