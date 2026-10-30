import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeyboardShortcuts } from './KeyboardShortcuts';

describe('KeyboardShortcuts', () => {
  it('opens the shortcut list when ? is pressed', () => {
    render(<KeyboardShortcuts />);
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('Formatting command palette')).toBeInTheDocument();
  });

  it('leaves ? alone while the user is typing in a field', () => {
    render(
      <>
        <input aria-label="Title" />
        <KeyboardShortcuts />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText('Title'), { key: '?' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is reachable from a visible header button', () => {
    render(<KeyboardShortcuts />);
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});
