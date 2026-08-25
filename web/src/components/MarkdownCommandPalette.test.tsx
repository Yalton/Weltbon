import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MarkdownCommandPalette } from './MarkdownCommandPalette';
import { markdownAuthoringCommands } from './MarkdownAuthoringEditor';

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
});
