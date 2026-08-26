import { readFileSync } from 'node:fs';
import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { markdownShortcutPlugin } from '@mdxeditor/editor';
import {
  canonicalizeLiveMarkdown,
  MarkdownAuthoringEditor,
  splitUnsupportedBlocks,
  type MarkdownAuthoringEditorHandle,
} from './MarkdownAuthoringEditor';

const markdownAuthoringEditorCss = readFileSync('src/components/MarkdownAuthoringEditor.css', 'utf8');

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

function selectLiveSubstring(textValue: string, occurrence = 0, collapsed = false) {
  const editor = screen.getByRole('textbox');
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const matches: Array<{ node: Text; offset: number }> = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    const offset = node.data.indexOf(textValue);
    if (offset !== -1) matches.push({ node, offset });
    node = walker.nextNode() as Text | null;
  }
  const match = matches[occurrence];
  Object.assign(match.node, { getBoundingClientRect: () => editor.getBoundingClientRect() });
  const range = document.createRange();
  range.setStart(match.node, match.offset);
  range.setEnd(match.node, collapsed ? match.offset : match.offset + textValue.length);
  act(() => {
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
}

function clearLiveSelection() {
  act(() => window.getSelection()?.removeAllRanges());
}

describe('MarkdownAuthoringEditor', () => {
  it('removes MDXEditor trailing-space entities from ATX headings', () => {
    expect(canonicalizeLiveMarkdown('# Tst&#x20;')).toBe('# Tst');
    expect(canonicalizeLiveMarkdown('# Tst&#32;\n\nParagraph')).toBe('# Tst\n\nParagraph');
    expect(canonicalizeLiveMarkdown('> # Tst&#x20;\n- # List&#32;')).toBe('> # Tst\n- # List');
    expect(canonicalizeLiveMarkdown('**Tst&#x20;**')).toBe('**Tst&#x20;**');
    expect(canonicalizeLiveMarkdown('```md\n# literal&#x20;\n```')).toBe('```md\n# literal&#x20;\n```');
    expect(canonicalizeLiveMarkdown('```md\n- ```\n# literal&#x20;\n```')).toBe('```md\n- ```\n# literal&#x20;\n```');
    expect(canonicalizeLiveMarkdown('> ```md\n> # literal&#x20;\n> ```')).toBe('> ```md\n> # literal&#x20;\n> ```');
    expect(canonicalizeLiveMarkdown('- ```md\n  # literal&#x20;\n  ```')).toBe('- ```md\n  # literal&#x20;\n  ```');
    expect(canonicalizeLiveMarkdown('- > ```md\n  > # literal&#x20;\n  > ```\n\n# after&#x20;')).toBe(
      '- > ```md\n  > # literal&#x20;\n  > ```\n\n# after',
    );
    expect(canonicalizeLiveMarkdown('> - ```md\n>   # literal&#x20;\n>   ```\n\n# after&#x20;')).toBe(
      '> - ```md\n>   # literal&#x20;\n>   ```\n\n# after',
    );
    expect(canonicalizeLiveMarkdown('10. ```md\n    # literal&#x20;\n    ```\n\n# after&#x20;')).toBe(
      '10. ```md\n    # literal&#x20;\n    ```\n\n# after',
    );
    expect(canonicalizeLiveMarkdown('10. ```md\n    literal\n# after&#x20;')).toBe(
      '10. ```md\n    literal\n# after',
    );
    expect(canonicalizeLiveMarkdown('- > ```md\n  > literal\n- > # after&#x20;')).toBe(
      '- > ```md\n  > literal\n- > # after',
    );
    expect(canonicalizeLiveMarkdown('```js`\n# literal&#x20;\n```')).toBe(
      '```js`\n# literal\n```',
    );
    expect(canonicalizeLiveMarkdown('# H&#x20;', '# H&#x20;')).toBe('# H&#x20;');
    expect(canonicalizeLiveMarkdown('# Hello&#x20;', '# H&#x20;')).toBe('# Hello&#x20;');
    expect(canonicalizeLiveMarkdown('# B\n# A&#x20;', '# A&#x20;')).toBe('# B\n# A&#x20;');
    expect(canonicalizeLiveMarkdown('# New&#x20;\n# Saved&#x20;', '# Saved&#x20;')).toBe(
      '# New\n# Saved&#x20;',
    );
    expect(canonicalizeLiveMarkdown('# New&#x20;')).toBe('# New');
  });

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

  it('replaces a selected Source range through the link dialog with canonical Markdown', () => {
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor value="selected" onChange={onChange} universeId="U1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    source.setSelectionRange(0, 8);
    fireEvent.select(source);
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    fireEvent.change(screen.getByLabelText('Link target'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('Accessible text'), { target: { value: 'Example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));

    expect(onChange).toHaveBeenLastCalledWith('[Example](https://example.com)');
  });

  it.each([
    ['[[Title]]', 'Wikilink', 'Title', '', '[[Renamed]]'],
    ['[[Title|alias]]', 'Wikilink', 'Title', 'alias', '[[Renamed|alias]]'],
    ['![[Title]]', 'Embed', 'Title', '', '![[Renamed]]'],
  ])('initializes %s as its canonical dialog kind and preserves its alias', (selected, kind, target, alias, expected) => {
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor value={selected} onChange={onChange} universeId="U1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    source.setSelectionRange(0, selected.length);
    fireEvent.select(source);
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    expect(screen.getByRole('button', { name: kind })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Link target')).toHaveValue(target);
    expect(screen.getByLabelText('Display text / alt text')).toHaveValue(alias);

    fireEvent.change(screen.getByLabelText('Link target'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));
    expect(onChange).toHaveBeenLastCalledWith(expected);
  });

  it('routes Ctrl/Cmd-K to the link dialog instead of inserting a placeholder', () => {
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor value="selected" onChange={onChange} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));

    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'k', ctrlKey: true });

    expect(screen.getByRole('dialog', { name: 'Insert Markdown link' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('routes the Link command from the command palette to the link dialog', () => {
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor value="selected" onChange={onChange} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'p', ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole('option', { name: /^Link/ }));

    expect(screen.getByRole('dialog', { name: 'Insert Markdown link' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores Source focus and selection when the link dialog is cancelled', async () => {
    render(<MarkdownAuthoringEditor value="selected" onChange={vi.fn()} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    source.setSelectionRange(1, 5);
    fireEvent.select(source);
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(screen.getByLabelText('Link target')).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(source).toHaveFocus();
      expect(source.selectionStart).toBe(1);
      expect(source.selectionEnd).toBe(5);
    });
  });

  it('replaces selected Live Preview text through the link dialog', async () => {
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor value="selected" onChange={onChange} universeId="U1" />);
    selectLiveText('p');
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));

    fireEvent.change(screen.getByLabelText('Link target'), { target: { value: 'https://example.com' } });
    fireEvent.change(screen.getByLabelText('Accessible text'), { target: { value: 'Example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert link' }));

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('[Example](https://example.com)'));
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('adds a row through the safe table controls in Source mode', () => {
    const onChange = vi.fn();
    const table = '| Name | Value |\n| --- | --- |\n| One | 1 |';
    render(<MarkdownAuthoringEditor value={table} onChange={onChange} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add table row' }));

    expect(onChange).toHaveBeenLastCalledWith(`${table}\n|  |  |`);
  });

  it('updates table controls when Source selection moves to a later table', () => {
    const firstTable = '| First |\n| --- |';
    const secondTable = '| Name | Value |\n| --- | --- |\n| One | 1 |\n| Two | 2 |';
    const document = `${firstTable}\n\n${secondTable}`;
    render(<ControlledEditor value={document} />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    const secondTableStart = firstTable.length + 2;
    source.setSelectionRange(secondTableStart, secondTableStart + secondTable.length);
    fireEvent.select(source);

    expect(screen.getByRole('button', { name: 'Remove table row' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove table row' }));

    expect(screen.getByTestId('markdown-value').textContent).toBe(
      `${firstTable}\n\n${secondTable.replace(/\n\| Two \| 2 \|$/, '')}`,
    );
  });

  it('updates Live Preview table controls for a selected non-first table', () => {
    const firstTable = '| First |\n| --- |\n| A |';
    const secondTable = '| Name | Value |\n| --- | --- |\n| One | 1 |\n| Two | 2 |';
    const markdownDocument = `${firstTable}\n\n${secondTable}`;
    render(<ControlledEditor value={markdownDocument} />);

    selectLiveTextOccurrence('Two', 0);
    act(() => globalThis.document.dispatchEvent(new Event('selectionchange')));

    expect(screen.getByRole('button', { name: 'Remove table row' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove table row' }));

    expect(screen.getByTestId('markdown-value').textContent).toBe(
      `${firstTable}\n\n${secondTable.replace(/\n\| Two \| 2 \|$/, '')}`,
    );
  });

  it('maps the active Live Preview selection when switching to Source', () => {
    const markdownDocument = 'First paragraph.\n\nSecond paragraph.';
    render(<ControlledEditor value={markdownDocument} />);

    selectLiveTextOccurrence('Second paragraph.', 0);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));

    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    const start = markdownDocument.indexOf('Second paragraph.');
    expect(source.selectionStart).toBe(start);
    expect(source.selectionEnd).toBe(start + 'Second paragraph.'.length);
  });

  it('isolates malformed table-shaped blocks without changing Source round trips', () => {
    const malformedTable = '| Name | Value |\n| --- |\n| One | 1 |';
    const markdownDocument = `Before\n\n${malformedTable}\n\nAfter`;
    render(<ControlledEditor value={markdownDocument} />);

    expect(screen.getByLabelText('Raw Markdown block').textContent).toBe(malformedTable);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('textbox', { name: 'Entry body' })).toHaveValue(markdownDocument);
  });

  it('isolates an incomplete table header and delimiter pair at EOF', () => {
    const malformedTable = '| Name | Value |\n| --- |';
    render(<ControlledEditor value={malformedTable} />);

    expect(screen.getByLabelText('Raw Markdown block').textContent).toBe(malformedTable);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('textbox', { name: 'Entry body' })).toHaveValue(malformedTable);
  });

  it('isolates an incomplete table pair before a prose boundary', () => {
    const malformedTable = '| Name | Value |\n| --- |';
    const markdownDocument = `${malformedTable}\n\nAfter`;
    render(<ControlledEditor value={markdownDocument} />);

    expect(screen.getByLabelText('Raw Markdown block').textContent).toBe(malformedTable);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('textbox', { name: 'Entry body' })).toHaveValue(markdownDocument);
  });

  it.each([
    '| Name | Value |\n| --- | --- |\n| One | 1 |',
    '| Name | Value |\n| --- | --- |',
    'A | B\n\nC | D',
  ])('does not isolate valid tables or ordinary pipe prose as raw Markdown: %s', (document) => {
    render(<ControlledEditor value={document} />);

    expect(screen.queryByLabelText('Raw Markdown block')).not.toBeInTheDocument();
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

  it.each([
    'Prose containing ::: should remain an editable paragraph.',
  ])('does not isolate ::: inside prose or fenced code: %s', (markdownDocument) => {
    render(<ControlledEditor value={markdownDocument} />);

    expect(screen.queryByLabelText('Raw Markdown block')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
  });

  it('keeps directive-like text inside fenced code in the editable Markdown part', () => {
    const fencedCode = '```\n::: is code content, not a directive\n```';

    expect(splitUnsupportedBlocks(fencedCode)).toEqual([{ kind: 'markdown', content: fencedCode }]);
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
    fireEvent.keyDown(screen.getByRole('region', { name: 'Markdown authoring editor' }), { key: 'p', ctrlKey: true, shiftKey: true });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[0][0]).toBe('**bold**');
    expect(onChange.mock.calls[1][0]).toContain('*italic*');
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

  it('formats selected text on the second line of a multiline Live Preview blockquote', async () => {
    render(<ControlledEditor value={'> First line\n> Second line'} />);
    selectLiveSubstring('Second line');

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    clearLiveSelection();

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent('> First line > **Second line**'));
  });

  it('formats only the selected Live Preview link label', async () => {
    render(<ControlledEditor value={'Keep [first](https://first.test) and [second](https://second.test).'} />);
    selectLiveSubstring('second');

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    clearLiveSelection();

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent(
      'Keep [first](https://first.test) and [**second**](https://second.test).',
    ));
  });

  it('does not mutate canonical Markdown when a selected Live Preview character is escaped', () => {
    const onChange = vi.fn();
    render(<MarkdownAuthoringEditor value={'\\*'} onChange={onChange} universeId="U1" />);
    selectLiveSubstring('*');

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('converts the linked Live Preview block containing a collapsed caret', async () => {
    render(<ControlledEditor value={'First block\n\n[second](https://second.test)'} />);
    selectLiveSubstring('second', 0, true);

    fireEvent.click(screen.getByRole('button', { name: 'Heading 1' }));
    clearLiveSelection();

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent(
      'First block # [second](https://second.test)',
    ));
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

  it('scopes a readable MDXEditor surface without relying on a parent dark class', () => {
    render(<ControlledEditor value="Text" />);

    expect(screen.getByRole('region', { name: 'Markdown authoring editor' })).toHaveClass(
      'markdown-authoring-surface',
      'bg-neutral-950',
      'text-neutral-100',
      'dark:bg-neutral-950',
      'dark:text-neutral-100',
    );
    const editorTheme = screen.getByRole('textbox').closest('.markdown-authoring-editor-theme');
    expect(editorTheme).not.toBeNull();
  });

  it('keeps code and quote surfaces dark without a parent theme class', () => {
    expect(markdownAuthoringEditorCss).toContain('.markdown-authoring-editor-theme .prose.prose code');
    expect(markdownAuthoringEditorCss).toContain('.markdown-authoring-editor-theme .prose.prose pre');
    expect(markdownAuthoringEditorCss).toContain('.markdown-authoring-editor-theme .prose.prose blockquote');
  });
});
