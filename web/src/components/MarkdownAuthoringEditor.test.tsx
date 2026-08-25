import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { markdownShortcutPlugin } from '@mdxeditor/editor';
import { MarkdownAuthoringEditor, type MarkdownAuthoringEditorHandle } from './MarkdownAuthoringEditor';

vi.mock('@mdxeditor/editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mdxeditor/editor')>();
  return { ...actual, markdownShortcutPlugin: vi.fn(actual.markdownShortcutPlugin) };
});

const UNSUPPORTED_BLOCK = ':::mermaid\ngraph TD\n  A --> B\n:::';
const DOCUMENT = `# Title\n\nA paragraph with [[Weltbon]].\n\n${UNSUPPORTED_BLOCK}`;

Object.assign(Range.prototype, {
  getBoundingClientRect: () => new DOMRect(),
});

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

function selectLiveText(selector: string) {
  const editor = screen.getByRole('textbox');
  editor.focus();
  fireEvent.focus(editor);
  const text = editor.querySelector(selector)?.firstChild as Text;
  Object.assign(text, { getBoundingClientRect: () => editor.getBoundingClientRect() });
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection();
  act(() => {
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

function selectLiveTextOccurrence(textValue: string, occurrence: number, start = 0, end?: number) {
  const text = screen.getAllByText(textValue)[occurrence]?.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end ?? text.textContent?.length ?? 0);
  const selection = window.getSelection();
  act(() => {
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

function clearLiveSelection() {
  act(() => window.getSelection()?.removeAllRanges());
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

  it('isolates unsupported callouts as lossless raw Markdown blocks', () => {
    const unsupportedCallout = '> [!DANGER]\n> Keep every byte.';
    render(<ControlledEditor value={`# Heading\n\n${unsupportedCallout}\n\nTail`} />);

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByLabelText('Raw Markdown block').textContent).toBe(unsupportedCallout);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('textbox', { name: 'Entry body' })).toHaveValue(
      `# Heading\n\n${unsupportedCallout}\n\nTail`,
    );
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

  it('does not run formatting commands from a raw recovery block', () => {
    const editorRef = createRef<MarkdownAuthoringEditorHandle>();
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor ref={editorRef} value={UNSUPPORTED_BLOCK} onChange={onChange} universeId="U1" />);

    fireEvent.click(screen.getByLabelText('Raw Markdown block'));
    editorRef.current?.executeCommand('heading-1');

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Raw Markdown block').textContent).toBe(UNSUPPORTED_BLOCK);
  });

  it('restores focus to the later live editor after a Source-mode round trip', () => {
    render(<ControlledEditor value={`# First\n\n${UNSUPPORTED_BLOCK}\n\n# Second`} />);
    const liveEditors = screen.getAllByRole('textbox');
    liveEditors[1].focus();

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));

    expect(screen.getAllByRole('textbox')[1]).toHaveFocus();
  });

  it.each([
    ['heading-1', '# Heading'],
    ['paragraph', 'Paragraph'],
    ['quote', '> Quote'],
    ['callout-note', '> [!NOTE]\n> Callout'],
    ['bullet-list', '- Item'],
    ['ordered-list', '1. Item'],
    ['task-list', '- [ ] Task'],
    ['code-block', '```\ncode\n```'],
    ['horizontal-rule', '---'],
    ['bold', '**bold**'],
    ['italic', '*italic*'],
    ['strikethrough', '~~strikethrough~~'],
    ['inline-code', '`code`'],
    ['clear-formatting', 'Plain text'],
  ])('runs the %s registry command through the editor insertion path', (command, expected) => {
    const editorRef = createRef<MarkdownAuthoringEditorHandle>();
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor ref={editorRef} value="" onChange={onChange} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));

    editorRef.current?.executeCommand(command as never);

    expect(onChange).toHaveBeenLastCalledWith(expected);
  });

  it('wraps and clears the selected Source text through the command registry', () => {
    const editorRef = createRef<MarkdownAuthoringEditorHandle>();
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor ref={editorRef} value="selected" onChange={onChange} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    source.setSelectionRange(0, 8);
    fireEvent.select(source);

    editorRef.current?.executeCommand('bold');

    expect(onChange).toHaveBeenLastCalledWith('**selected**');
  });

  it('converts the current Source block instead of appending a template', () => {
    const editorRef = createRef<MarkdownAuthoringEditorHandle>();
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor ref={editorRef} value="Paragraph" onChange={onChange} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    source.setSelectionRange(0, 9);
    fireEvent.select(source);

    editorRef.current?.executeCommand('heading-1');

    expect(onChange).toHaveBeenLastCalledWith('# Paragraph');
  });

  it('routes standard formatting and palette shortcuts to the same command registry', () => {
    const editorRef = createRef<MarkdownAuthoringEditorHandle>();
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor ref={editorRef} value="" onChange={onChange} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));

    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'b', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'i', metaKey: true });
    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'k', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'p', ctrlKey: true, shiftKey: true });

    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls[0][0]).toBe('**bold**');
    expect(onChange.mock.calls[1][0]).toContain('*italic*');
    expect(onChange.mock.calls[2][0]).toContain('[link text](https://)');
    expect(screen.getByRole('dialog', { name: 'Formatting commands' })).toBeInTheDocument();
  });

  it('formats the selected Live Preview text through the native editor command', async () => {
    render(<ControlledEditor value="selected" />);
    selectLiveText('p');

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    clearLiveSelection();

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent('**selected**'));
  });

  it('converts the current Live Preview block instead of appending a template', async () => {
    render(<ControlledEditor value="Paragraph" />);
    selectLiveText('p');

    fireEvent.click(screen.getByRole('button', { name: 'Heading 1' }));
    clearLiveSelection();

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent('# Paragraph'));
  });

  it('converts the Live Preview block containing a collapsed caret, not the first block', async () => {
    render(<ControlledEditor value={'First\n\nSecond'} />);
    selectLiveTextOccurrence('Second', 0, 3, 3);

    fireEvent.click(screen.getByRole('button', { name: 'Heading 1' }));
    clearLiveSelection();

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent('First # Second'));
  });

  it('formats duplicate Live Preview text at the selected occurrence', async () => {
    render(<ControlledEditor value={'duplicate\n\nduplicate'} />);
    selectLiveTextOccurrence('duplicate', 1);

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    clearLiveSelection();

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent('duplicate **duplicate**'));
  });

  it('clears selected Live Preview formatting through the native editor command', async () => {
    render(<ControlledEditor value="**selected**" />);
    selectLiveText('strong');

    fireEvent.click(screen.getByRole('button', { name: 'Clear formatting' }));
    clearLiveSelection();

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent(/^selected$/));
  });

  it('blocks toolbar, hotkey, palette, and imperative commands when disabled', () => {
    const editorRef = createRef<MarkdownAuthoringEditorHandle>();
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor ref={editorRef} value="text" onChange={onChange} universeId="U1" disabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'b', ctrlKey: true });
    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'p', ctrlKey: true, shiftKey: true });
    editorRef.current?.executeCommand('bold');

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Formatting commands' })).not.toBeInTheDocument();
  });

  it('blocks an existing imperative handle after the editor becomes disabled', () => {
    const editorRef = createRef<MarkdownAuthoringEditorHandle>();
    const onChange = vi.fn();
    const { rerender } = render(<MarkdownAuthoringEditor ref={editorRef} value="text" onChange={onChange} universeId="U1" />);

    rerender(<MarkdownAuthoringEditor ref={editorRef} value="text" onChange={onChange} universeId="U1" disabled />);
    editorRef.current?.executeCommand('bold');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('configures native Markdown shortcuts for the Live Preview contenteditable', () => {
    render(<ControlledEditor value="" />);

    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
    expect(vi.mocked(markdownShortcutPlugin)).toHaveBeenCalled();
  });

  it('scopes a readable MDXEditor surface inside the app dark theme', () => {
    render(<div className="dark"><ControlledEditor value="Text" /></div>);

    expect(screen.getByRole('region', { name: 'Markdown authoring editor' })).toHaveClass(
      'markdown-authoring-surface',
      'dark:bg-neutral-950',
      'dark:text-neutral-100',
    );
    expect(screen.getByRole('textbox').closest('.markdown-authoring-editor-theme')).not.toBeNull();
  });
});
