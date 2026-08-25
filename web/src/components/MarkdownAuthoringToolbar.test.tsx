import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MarkdownAuthoringToolbar } from './MarkdownAuthoringToolbar';
import { markdownAuthoringCommands } from './MarkdownAuthoringEditor';

describe('MarkdownAuthoringToolbar', () => {
  it('exposes labelled common formatting controls that invoke registry commands', () => {
    const onCommand = vi.fn();
    render(
      <MarkdownAuthoringToolbar
        commands={markdownAuthoringCommands}
        onCommand={onCommand}
        onOpenPalette={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Heading 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Task list' }));

    expect(onCommand).toHaveBeenNthCalledWith(1, 'bold');
    expect(onCommand).toHaveBeenNthCalledWith(2, 'heading-1');
    expect(onCommand).toHaveBeenNthCalledWith(3, 'task-list');
  });

  it('keeps a compact, non-hover mobile command path to the palette', () => {
    const onOpenPalette = vi.fn();
    render(
      <MarkdownAuthoringToolbar
        commands={markdownAuthoringCommands}
        onCommand={vi.fn()}
        onOpenPalette={onOpenPalette}
      />,
    );

    const more = screen.getByRole('button', { name: 'More formatting commands' });
    expect(more).toHaveClass('sm:hidden');
    fireEvent.click(more);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });
});
