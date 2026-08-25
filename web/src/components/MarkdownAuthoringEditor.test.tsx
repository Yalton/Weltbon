import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownAuthoringEditor, type MarkdownAuthoringEditorHandle } from './MarkdownAuthoringEditor';

const UNSUPPORTED_BLOCK = ':::mermaid\ngraph TD\n  A --> B\n:::';
const DOCUMENT = `# Title\n\nA paragraph with [[Weltbon]].\n\n${UNSUPPORTED_BLOCK}`;

function ControlledEditor({ value = DOCUMENT }: { value?: string }) {
  const [markdown, setMarkdown] = useState(value);
  return (
    <>
      <MarkdownAuthoringEditor
        value={markdown}
        onChange={setMarkdown}
        universeId="U1"
        entryId="E1"
      />
      <output data-testid="markdown-value">{markdown}</output>
    </>
  );
}

function AssetInsertionEditor({ value }: { value: string }) {
  const [markdown, setMarkdown] = useState(value);
  const editorRef = createRef<MarkdownAuthoringEditorHandle>();
  return (
    <>
      <MarkdownAuthoringEditor ref={editorRef} value={markdown} onChange={setMarkdown} universeId="U1" />
      <button type="button" onClick={() => editorRef.current?.insertMarkdown('![image](asset://asset-1)')}>Insert asset</button>
      <output data-testid="markdown-value">{markdown}</output>
    </>
  );
}

describe('MarkdownAuthoringEditor', () => {
  it('passes Markdown through unchanged when the document changes', () => {
    render(<ControlledEditor value="initial" />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Entry body' }), {
      target: { value: '[[Weltbon|the world]]\n\n![map](asset://asset-1)' },
    });

    expect(screen.getByTestId('markdown-value')).toHaveTextContent(
      '[[Weltbon|the world]] ![map](asset://asset-1)',
    );
  });

  it('emits exact Markdown from Source mode without whitespace normalization', () => {
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor value="before" onChange={onChange} universeId="U1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Entry body' }), {
      target: { value: '[[Weltbon|the world]]\n\n![map](asset://asset-1)' },
    });

    expect(onChange).toHaveBeenLastCalledWith('[[Weltbon|the world]]\n\n![map](asset://asset-1)');
  });

  it('starts in Live Preview and presents completed headings as blocks', () => {
    render(<ControlledEditor value="# Title" />);

    expect(screen.getByRole('button', { name: 'Live Preview' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
  });

  it('exposes the complete raw document in Source mode, including unsupported blocks', () => {
    render(<ControlledEditor />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));

    expect(screen.getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Entry body' })).toHaveValue(DOCUMENT);
  });

  it('keeps supported Weltbon syntax in the editable live document and isolates only unsupported blocks', () => {
    render(
      <ControlledEditor value={`# Heading\n\nSee [[Weltbon]].\n\n![[Map]]\n\n![map](asset://asset-1)\n\n${UNSUPPORTED_BLOCK}`} />,
    );

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
    expect(screen.getByLabelText('Raw Markdown block').textContent).toBe(UNSUPPORTED_BLOCK);
  });

  it('keeps an unclosed unsupported block recoverable without hiding preceding live content', () => {
    const malformedBlock = ':::mermaid\ngraph TD\n  A --> B';
    render(<ControlledEditor value={`# Heading\n\n${malformedBlock}`} />);

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByLabelText('Raw Markdown block').textContent).toBe(malformedBlock);
  });

  it('keeps content and the current source selection when switching modes', () => {
    render(<ControlledEditor />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: `${DOCUMENT}\n\nTail` } });
    source.setSelectionRange(3, 8);
    fireEvent.select(source);

    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));

    const restored = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    expect(restored).toHaveValue(`${DOCUMENT}\n\nTail`);
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(8);
  });

  it('makes the active block editable in Live Preview', () => {
    render(<ControlledEditor value="# Title" />);

    fireEvent.click(screen.getByRole('heading', { name: 'Title' }));

    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
  });

  it('restores a focused live block after a Source-mode round trip', () => {
    render(<ControlledEditor value="# Title" />);
    const liveEditor = screen.getByRole('textbox');
    liveEditor.focus();

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));

    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('restores the live caret after a Source-mode round trip', () => {
    render(<ControlledEditor value="# Title" />);
    const headingText = screen.getByRole('heading', { name: 'Title' }).querySelector('span')?.firstChild as Text;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(headingText, 2);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));

    expect(window.getSelection()?.anchorNode).toBe(headingText);
    expect(window.getSelection()?.anchorOffset).toBe(2);
  });

  it('inserts an asset at the tracked Source selection with Markdown block separators', () => {
    render(<AssetInsertionEditor value="beforeafter" />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    act(() => {
      source.setSelectionRange(6, 6);
      fireEvent.select(source);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Insert asset' }));

    expect(screen.getByTestId('markdown-value').textContent).toBe(
      'before\n\n![image](asset://asset-1)\n\nafter',
    );
  });

  it('inserts after the focused raw fallback block with Markdown block separators', () => {
    render(<AssetInsertionEditor value={`${UNSUPPORTED_BLOCK}\n\nafter`} />);

    fireEvent.click(screen.getByLabelText('Raw Markdown block'));
    fireEvent.click(screen.getByRole('button', { name: 'Insert asset' }));

    expect(screen.getByTestId('markdown-value').textContent).toBe(
      `${UNSUPPORTED_BLOCK}\n\n![image](asset://asset-1)\n\nafter`,
    );
  });

  it('restores focus to the later live editor after a Source-mode round trip', () => {
    render(<ControlledEditor value={`# First\n\n${UNSUPPORTED_BLOCK}\n\n# Second`} />);
    const liveEditors = screen.getAllByRole('textbox');
    liveEditors[1].focus();

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));

    expect(screen.getAllByRole('textbox')[1]).toHaveFocus();
  });
});
