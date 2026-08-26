import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  MarkdownTableControls,
  addMarkdownTableColumn,
  addMarkdownTableRow,
  removeMarkdownTableColumn,
  removeMarkdownTableRow,
} from './MarkdownTableControls';

const TABLE = '| Name | Value |\n| --- | --- |\n| One | 1 |';

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
});

describe('MarkdownTableControls', () => {
  it('emits exact Markdown when a row is inserted', () => {
    const onChange = vi.fn();
    render(<MarkdownTableControls markdown={TABLE} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add table row' }));

    expect(onChange).toHaveBeenCalledWith(`${TABLE}\n|  |  |`);
  });

  it('keeps unsupported table blocks untouched and disables mutations', () => {
    const onChange = vi.fn();
    render(<MarkdownTableControls markdown={'| Name | Value |\n| --- |\n| One | 1 |'} onChange={onChange} />);

    expect(screen.getByRole('button', { name: 'Add table row' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add table row' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
