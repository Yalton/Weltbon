import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MarkdownFrontmatterPanel } from './MarkdownFrontmatterPanel';
import { parseMarkdownFrontmatter, replaceSupportedFrontmatterTags } from '../lib/markdownAuthoring';

describe('MarkdownFrontmatterPanel', () => {
  it('labels document tags and publishes chip edits through Markdown', () => {
    const onChange = vi.fn();
    render(<MarkdownFrontmatterPanel markdown={'---\ntitle: Story\n---\nBody'} onChange={onChange} />);

    expect(screen.getByRole('region', { name: 'Document tags' })).toBeInTheDocument();
    expect(parseMarkdownFrontmatter('---\ntitle: Story\n---\nBody').diagnostics).toEqual([]);
    expect(replaceSupportedFrontmatterTags('---\ntitle: Story\n---\nBody', ['journal'])).toBe('---\ntitle: Story\ntags: [journal]\n---\nBody');
    const input = screen.getByPlaceholderText('Add a tag...');
    fireEvent.change(input, { target: { value: 'journal' } });
    expect(input).toHaveValue('journal');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenLastCalledWith('---\ntitle: Story\ntags: [journal]\n---\nBody');
  });

  it('creates a document frontmatter block when adding the first tag', () => {
    const onChange = vi.fn();
    render(<MarkdownFrontmatterPanel markdown="Body" onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('Add a tag...'), { target: { value: 'one' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Add a tag...'), { key: 'Enter' });

    expect(onChange).toHaveBeenLastCalledWith('---\ntags: [one]\n---\nBody');
  });

  it('shows a non-modal diagnostic and offers Source recovery for malformed frontmatter', () => {
    const onChange = vi.fn();
    const onEditInSource = vi.fn();
    render(
      <MarkdownFrontmatterPanel
        markdown={'---\ntags: ["unterminated]\n---\nBody'}
        onChange={onChange}
        onEditInSource={onEditInSource}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Frontmatter');
    fireEvent.change(screen.getByPlaceholderText('Add a tag...'), { target: { value: 'new' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Add a tag...'), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit in Source' }));
    expect(onEditInSource).toHaveBeenCalledTimes(1);
  });

  it('does not mutate a separate entry metadata value', () => {
    const onChange = vi.fn();
    const entryTags = ['application-tag'];
    render(<MarkdownFrontmatterPanel markdown="Body" onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('Add a tag...'), { target: { value: 'document-tag' } });
    fireEvent.keyDown(screen.getByPlaceholderText('Add a tag...'), { key: 'Enter' });

    expect(entryTags).toEqual(['application-tag']);
    expect(onChange).toHaveBeenCalledWith('---\ntags: [document-tag]\n---\nBody');
  });
});
