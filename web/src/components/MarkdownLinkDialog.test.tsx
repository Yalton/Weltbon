import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  MarkdownLinkDialog,
  buildMarkdownLink,
  type MarkdownLinkValue,
} from './MarkdownLinkDialog';

describe('buildMarkdownLink', () => {
  it.each([
    [{ kind: 'wikilink', target: 'Title', label: '' }, '[[Title]]'],
    [{ kind: 'wikilink', target: 'Title', label: 'alias' }, '[[Title|alias]]'],
    [{ kind: 'embed', target: 'Title', label: '' }, '![[Title]]'],
    [{ kind: 'external', target: 'https://example.com', label: 'accessible text' }, '[accessible text](https://example.com)'],
    [{ kind: 'image', target: 'asset-1', label: 'alt text' }, '![alt text](asset://asset-1)'],
  ] satisfies Array<[MarkdownLinkValue, string]>)('builds canonical Markdown for %j', (value, expected) => {
    expect(buildMarkdownLink(value)).toBe(expected);
  });
});

describe('MarkdownLinkDialog', () => {
  it('inserts an unresolved wikilink typed by the author', () => {
    const onInsert = vi.fn();
    render(<MarkdownLinkDialog open onOpenChange={vi.fn()} onInsert={onInsert} universeId="u1" entries={[]} />);

    expect(screen.getByLabelText('Link target')).toHaveFocus();

    fireEvent.change(screen.getByLabelText('Link target'), { target: { value: 'Missing entry' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));

    expect(onInsert).toHaveBeenCalledWith('[[Missing entry]]');
  });

  it('builds an accessible external link from the dialog fields', () => {
    const onInsert = vi.fn();
    render(<MarkdownLinkDialog open onOpenChange={vi.fn()} onInsert={onInsert} universeId="u1" initialKind="external" entries={[]} />);

    fireEvent.change(screen.getByLabelText('Link target'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('Accessible text'), { target: { value: 'Example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));

    expect(onInsert).toHaveBeenCalledWith('[Example](https://example.com)');
  });

  it('does not insert an external link with whitespace-only accessible text', () => {
    const onInsert = vi.fn();
    render(<MarkdownLinkDialog open onOpenChange={vi.fn()} onInsert={onInsert} universeId="u1" initialKind="external" entries={[]} />);

    fireEvent.change(screen.getByLabelText('Link target'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('Accessible text'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: 'Insert link' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));

    expect(onInsert).not.toHaveBeenCalled();
  });
});
