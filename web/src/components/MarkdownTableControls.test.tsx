import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  MarkdownTableControls,
  addMarkdownTableColumn,
  addMarkdownTableRow,
  findMalformedMarkdownTableRanges,
  removeMarkdownTableColumn,
  removeMarkdownTableRow,
} from './MarkdownTableControls';

const TABLE = '| Name | Value |\n| --- | --- |\n| One | 1 |';
const TABLE_SELECTION = { start: 0, end: TABLE.length };

describe('Markdown table transforms', () => {
  it('adds and removes rows without changing the surrounding Markdown', () => {
    expect(addMarkdownTableRow(TABLE)).toBe(`${TABLE}\n|  |  |`);
    expect(removeMarkdownTableRow(`${TABLE}\n| Two | 2 |`)).toBe(TABLE);
    expect(addMarkdownTableRow(`Before\n\n${TABLE}\n\nAfter`)).toBe(`Before\n\n${TABLE}\n|  |  |\n\nAfter`);
  });

  it('adds and removes columns while preserving the table delimiter row', () => {
    const withColumn = '| Name | Value |  |\n| --- | --- | --- |\n| One | 1 |  |';
    expect(addMarkdownTableColumn(TABLE)).toBe(withColumn);
    expect(removeMarkdownTableColumn(withColumn)).toBe(TABLE);
  });

  it('does not transform malformed tables', () => {
    const malformed = '| Name | Value |\n| --- |\n| One | 1 |';
    expect(addMarkdownTableRow(malformed)).toBe(malformed);
    expect(addMarkdownTableColumn(malformed)).toBe(malformed);
  });

  it('does not rewrite pipe-shaped tables inside fenced code', () => {
    const codeSample = '| Name | Value |\n| --- | --- |\n| Example | 1 |';
    const markdown = `\`\`\`md\n${codeSample}\n\`\`\`\n\n${TABLE}`;

    expect(addMarkdownTableRow(markdown)).toBe(`\`\`\`md\n${codeSample}\n\`\`\`\n\n${TABLE}\n|  |  |`);
  });

  it('keeps pipe-shaped content protected after a mismatched top-level fence closer', () => {
    const malformedCodeSample = '| Name | Value |\n| --- |\n| Example | 1 |';
    const markdown = `\`\`\`md\n> \`\`\`\n${malformedCodeSample}`;

    expect(findMalformedMarkdownTableRanges(markdown)).toEqual([]);
    expect(addMarkdownTableRow(markdown)).toBe(markdown);
  });

  it('keeps tables protected after a nested closer inside an unsupported directive', () => {
    const markdown = `:::mermaid\n> :::\n${TABLE}\n:::`;

    expect(findMalformedMarkdownTableRanges(markdown)).toEqual([]);
    expect(addMarkdownTableRow(markdown)).toBe(markdown);
  });

  it('releases later tables after an indented list-directive closer', () => {
    const directive = '- :::mermaid\n  graph TD\n  :::';
    const markdown = `${directive}\n\n${TABLE}`;

    expect(addMarkdownTableRow(markdown)).toBe(`${directive}\n\n${TABLE}\n|  |  |`);
  });

  it('does not rewrite pipe-shaped tables inside list or blockquote fences', () => {
    const nestedListFence = '- ~~~md\n  | Name | Value |\n  | --- | --- |\n  | Example | 1 |\n  ~~~';
    const nestedBlockquoteFence = '> ~~~md\n  | Name | Value |\n  | --- | --- |\n  | Example | 1 |\n> ~~~';

    expect(addMarkdownTableRow(nestedListFence)).toBe(nestedListFence);
    expect(addMarkdownTableColumn(nestedListFence)).toBe(nestedListFence);
    expect(addMarkdownTableRow(nestedBlockquoteFence)).toBe(nestedBlockquoteFence);
    expect(addMarkdownTableColumn(nestedBlockquoteFence)).toBe(nestedBlockquoteFence);
  });

  it('does not rewrite nested-list tables or four-space indented code samples', () => {
    const nestedListTable = '- Item\n\n  | Name | Value |\n  | --- | --- |\n  | Example | 1 |';
    const indentedCodeSample = '    | Name | Value |\n    | --- | --- |\n    | Example | 1 |';

    expect(addMarkdownTableRow(nestedListTable)).toBe(nestedListTable);
    expect(addMarkdownTableColumn(nestedListTable)).toBe(nestedListTable);
    expect(addMarkdownTableRow(indentedCodeSample)).toBe(indentedCodeSample);
    expect(addMarkdownTableColumn(indentedCodeSample)).toBe(indentedCodeSample);
  });

  it('does not choose the first table when a document has multiple tables', () => {
    const markdown = `${TABLE}\n\n${TABLE}`;

    expect(addMarkdownTableRow(markdown)).toBe(markdown);
    expect(addMarkdownTableColumn(markdown)).toBe(markdown);
  });
});

describe('MarkdownTableControls', () => {
  it('emits exact Markdown when a row is inserted', () => {
    const onChange = vi.fn();
    render(<MarkdownTableControls markdown={TABLE} onChange={onChange} getSelection={() => TABLE_SELECTION} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add table row' }));

    expect(onChange).toHaveBeenCalledWith(`${TABLE}\n|  |  |`);
  });

  it('disables row and column mutations without an active table selection', () => {
    const onChange = vi.fn();
    render(<MarkdownTableControls markdown={TABLE} onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'Add table row' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add table column' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add table row' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('mutates the selected table instead of the document first table', () => {
    const onChange = vi.fn();
    const markdown = `${TABLE}\n\n${TABLE}`;
    const secondTableStart = TABLE.length + 2;
    render(
      <MarkdownTableControls
        markdown={markdown}
        onChange={onChange}
        getSelection={() => ({ start: secondTableStart, end: secondTableStart + TABLE.length })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add table row' }));

    expect(onChange).toHaveBeenCalledWith(`${TABLE}\n\n${TABLE}\n|  |  |`);
  });

  it('keeps unsupported table blocks untouched and disables mutations', () => {
    const onChange = vi.fn();
    render(<MarkdownTableControls markdown={'| Name | Value |\n| --- |\n| One | 1 |'} onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'Add table row' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add table row' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
