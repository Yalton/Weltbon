import type { ReactNode } from 'react';

type TableLocation = {
  start: number;
  end: number;
  rows: string[][];
  delimiter: string[];
};

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

function protectedMarkdownLines(lines: string[]): boolean[] {
  const protectedLines = lines.map(() => false);
  let fence: FenceState | null = null;
  let rawDirective = false;

  lines.forEach((line, index) => {
    const fenceLine = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      protectedLines[index] = true;
      if (fenceLine && fenceLine[1][0] === fence.marker && fenceLine[1].length >= fence.length && line.slice(fenceLine[0].length).trim() === '') {
        fence = null;
      }
      return;
    }
    if (rawDirective) {
      protectedLines[index] = true;
      if (/^ {0,3}:::\s*$/.test(line)) rawDirective = false;
      return;
    }
    if (fenceLine) {
      protectedLines[index] = true;
      fence = { marker: fenceLine[1][0] as '`' | '~', length: fenceLine[1].length };
      return;
    }
    if (/^ {0,3}:::\s*\S+/.test(line)) {
      protectedLines[index] = true;
      rawDirective = true;
    }
  });
  return protectedLines;
}

function findTable(markdown: string): TableLocation | null {
  const lines = markdown.split('\n');
  const protectedLines = protectedMarkdownLines(lines);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (protectedLines[index] || protectedLines[index + 1]) continue;
    const header = splitTableRow(lines[index]);
    const delimiter = splitTableRow(lines[index + 1]);
    if (!header || !delimiter || header.length < 1 || header.length !== delimiter.length || !isDelimiterRow(delimiter)) continue;
    const rows = [header];
    let endIndex = index + 1;
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      if (protectedLines[rowIndex]) break;
      const row = splitTableRow(lines[rowIndex]);
      if (!row || row.length !== header.length) break;
      rows.push(row);
      endIndex = rowIndex;
    }
    return {
      start: lineStart(markdown, index),
      end: lineStart(markdown, endIndex) + lines[endIndex].length,
      rows,
      delimiter,
    };
  }
  return null;
}

function renderTable(location: TableLocation, rows: string[][], delimiter = location.delimiter): string {
  const lines = [rows[0], delimiter, ...rows.slice(1)];
  return lines.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function replaceTable(markdown: string, transform: (location: TableLocation) => string): string {
  const location = findTable(markdown);
  if (!location) return markdown;
  return `${markdown.slice(0, location.start)}${transform(location)}${markdown.slice(location.end)}`;
}

export function addMarkdownTableRow(markdown: string): string {
  return replaceTable(markdown, (location) => renderTable(location, [...location.rows, Array(location.rows[0].length).fill('')]));
}

export function removeMarkdownTableRow(markdown: string): string {
  return replaceTable(markdown, (location) => location.rows.length > 1
    ? renderTable(location, location.rows.slice(0, -1))
    : renderTable(location, location.rows));
}

export function addMarkdownTableColumn(markdown: string): string {
  return replaceTable(markdown, (location) => renderTable(
    location,
    location.rows.map((row) => [...row, '']),
    [...location.delimiter, '---'],
  ));
}

export function removeMarkdownTableColumn(markdown: string): string {
  return replaceTable(markdown, (location) => location.rows[0].length > 1
    ? renderTable(location, location.rows.map((row) => row.slice(0, -1)), location.delimiter.slice(0, -1))
    : renderTable(location, location.rows));
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
  children?: ReactNode;
};

export function MarkdownTableControls({ markdown, onChange, disabled = false, children }: MarkdownTableControlsProps) {
  const table = findTable(markdown);
  const canRemoveRow = !!table && table.rows.length > 1;
  const canRemoveColumn = !!table && table.rows[0].length > 1;
  const action = (transform: (value: string) => string) => {
    if (disabled || !table) return;
    onChange(transform(markdown));
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
