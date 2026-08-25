import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarkdownCommandPalette } from './MarkdownCommandPalette';
import { MarkdownAuthoringEditor, markdownAuthoringCommands } from './MarkdownAuthoringEditor';

Object.assign(Range.prototype, {
  getBoundingClientRect: () => new DOMRect(),
});

function PaletteHarness({ onCommand = vi.fn() }: { onCommand?: (command: string) => void }) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button">Return focus here</button>
      <MarkdownCommandPalette
        open={open}
        onOpenChange={setOpen}
        commands={markdownAuthoringCommands}
        onCommand={onCommand}
        returnFocusRef={triggerRef}
      />
    </>
  );
}

function ControlledEditor({ value = 'selected' }: { value?: string }) {
  const [markdown, setMarkdown] = useState(value);
  return (
    <>
      <MarkdownAuthoringEditor value={markdown} onChange={setMarkdown} universeId="U1" />
      <output data-testid="markdown-value">{markdown}</output>
    </>
  );
}

describe('MarkdownCommandPalette', () => {
  it('uses labelled roving keyboard navigation and invokes the selected registry command', () => {
    const onCommand = vi.fn();
    render(<PaletteHarness onCommand={onCommand} />);

    const bold = screen.getByRole('option', { name: /^Bold/ });
    bold.focus();
    fireEvent.keyDown(bold, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('option', { name: /^Italic/ }), { key: 'Enter' });

    expect(onCommand).toHaveBeenCalledWith('italic');
  });

  it('closes on Escape and restores focus to its trigger', async () => {
    render(<PaletteHarness />);

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Formatting commands' }), { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Formatting commands' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Return focus here' })).toHaveFocus());
  });

  it('restores Source focus and selection after Escape', async () => {
    render(<MarkdownAuthoringEditor value="source text" onChange={vi.fn()} universeId="U1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    act(() => {
      source.focus();
      source.setSelectionRange(1, 7);
      fireEvent.select(source);
    });

    fireEvent.keyDown(source, { key: 'p', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Formatting commands' }), { key: 'Escape' });

    await waitFor(() => expect(source).toHaveFocus());
    expect(source.selectionStart).toBe(1);
    expect(source.selectionEnd).toBe(7);
  });

  it('restores the Live Preview selection after Escape', async () => {
    render(<MarkdownAuthoringEditor value="selected" onChange={vi.fn()} universeId="U1" />);
    const editor = screen.getByRole('textbox');
    const text = editor.querySelector('p span')?.firstChild as Text;
    Object.assign(text, { getBoundingClientRect: () => editor.getBoundingClientRect() });
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 6);
    act(() => {
      editor.focus();
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });

    fireEvent.keyDown(editor, { key: 'p', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Formatting commands' }), { key: 'Escape' });

    await waitFor(() => expect(editor).toHaveFocus());
    expect(window.getSelection()?.toString()).toBe('lect');
  });

  it('restores the transformed Live Preview selection after command completion', async () => {
    render(<ControlledEditor />);
    const editor = screen.getByRole('textbox');
    const text = editor.querySelector('p span')?.firstChild as Text;
    Object.assign(text, { getBoundingClientRect: () => editor.getBoundingClientRect() });
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 6);
    act(() => {
      editor.focus();
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });

    fireEvent.keyDown(editor, { key: 'p', ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole('option', { name: /^Bold/ }));

    await waitFor(() => expect(screen.getByTestId('markdown-value')).toHaveTextContent('se**lect**ed'));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveFocus());
    const transformedText = screen.getByRole('textbox').querySelector('strong')?.firstChild;
    expect(window.getSelection()?.anchorNode).toBe(transformedText);
    expect(window.getSelection()?.anchorOffset).toBe(4);
  });
});
