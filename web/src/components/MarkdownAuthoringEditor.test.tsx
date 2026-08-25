import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MarkdownAuthoringEditor } from './MarkdownAuthoringEditor';

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

describe('MarkdownAuthoringEditor', () => {
  it('passes Markdown through unchanged when the document changes', () => {
    render(<ControlledEditor value="initial" />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.change(screen.getByLabelText('Entry body'), {
      target: { value: '[[Weltbon|the world]]\n\n![map](asset://asset-1)' },
    });

    expect(screen.getByTestId('markdown-value')).toHaveTextContent(
      '[[Weltbon|the world]] ![map](asset://asset-1)',
    );
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
    expect(screen.getByLabelText('Entry body')).toHaveValue(DOCUMENT);
  });

  it('keeps content and the current source selection when switching modes', () => {
    render(<ControlledEditor />);

    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByLabelText('Entry body') as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: `${DOCUMENT}\n\nTail` } });
    source.setSelectionRange(3, 8);
    fireEvent.select(source);

    fireEvent.click(screen.getByRole('button', { name: 'Live Preview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));

    const restored = screen.getByLabelText('Entry body') as HTMLTextAreaElement;
    expect(restored).toHaveValue(`${DOCUMENT}\n\nTail`);
    expect(restored.selectionStart).toBe(3);
    expect(restored.selectionEnd).toBe(8);
  });

  it('makes the active block editable in Live Preview', () => {
    render(<ControlledEditor value="# Title" />);

    fireEvent.click(screen.getByRole('heading', { name: 'Title' }));

    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'true');
  });
});
