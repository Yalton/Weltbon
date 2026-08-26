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

  it('disables chip controls when first-tag insertion is unsafe for the root', () => {
    for (const markdown of [
      '---\n{ title: Story }\n---\nBody',
      '---\ntitle: Story\n...\n---\nBody',
    ]) {
      const { unmount } = render(
        <MarkdownFrontmatterPanel
          markdown={markdown}
          onChange={vi.fn()}
          onEditInSource={vi.fn()}
        />,
      );

      expect(screen.getByPlaceholderText('Add a tag...')).toBeDisabled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      unmount();
    }
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

  it('disables chip controls when frontmatter is malformed', () => {
    render(
      <MarkdownFrontmatterPanel
        markdown={'---\ntitle: "unterminated\ntags: [one]\n---\nBody'}
        onChange={vi.fn()}
        onEditInSource={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('Add a tag...')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove tag one' })).toBeDisabled();
  });

  it('disables chip controls for multiline frontmatter tag values', () => {
    render(
      <MarkdownFrontmatterPanel
        markdown={'---\ntags:\n  - |\n    multi\n    line\n---\nBody'}
        onChange={vi.fn()}
        onEditInSource={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('Add a tag...')).toBeDisabled();
  });

  it('disables chip controls for non-string frontmatter tag scalars', () => {
    render(
      <MarkdownFrontmatterPanel
        markdown={'---\ntags: [123, true, null]\n---\nBody'}
        onChange={vi.fn()}
        onEditInSource={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('Add a tag...')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('scalar string');
  });

  it('disables chip controls when frontmatter cannot be safely prepended', () => {
    for (const markdown of ['\nBody', '--- heading\nBody']) {
      const { unmount } = render(
        <MarkdownFrontmatterPanel
          markdown={markdown}
          onChange={vi.fn()}
          onEditInSource={vi.fn()}
        />,
      );

      expect(screen.getByPlaceholderText('Add a tag...')).toBeDisabled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      unmount();
    }
  });

  it('disables chip controls when the tags key has source metadata before it', () => {
    for (const markdown of [
      '---\n# note\ntags: [one]\n---\nBody',
      '---\ntitle: x\n\ntags: [one]\n---\nBody',
    ]) {
      const { unmount } = render(
        <MarkdownFrontmatterPanel
          markdown={markdown}
          onChange={vi.fn()}
          onEditInSource={vi.fn()}
        />,
      );

      expect(screen.getByPlaceholderText('Add a tag...')).toBeDisabled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      unmount();
    }
  });

  it('disables chip controls when the panel is disabled', () => {
    render(
      <MarkdownFrontmatterPanel
        markdown={'---\ntags: [one]\n---\nBody'}
        onChange={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByPlaceholderText('Add a tag...')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove tag one' })).toBeDisabled();
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
