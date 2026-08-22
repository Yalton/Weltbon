import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SplitLevelControl } from '../SplitLevelControl';

const counts = { '1': 3, '2': 11, '3': 24 };

describe('SplitLevelControl', () => {
  it('shows an option per level with its entry count', () => {
    render(<SplitLevelControl detected={2} applied={2} counts={counts} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /H1.*3 entries/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /H2.*11 entries/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /H3.*24 entries/i })).toBeInTheDocument();
  });

  it('marks the applied level as selected', () => {
    render(<SplitLevelControl detected={2} applied={2} counts={counts} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /H2.*11 entries/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /H1.*3 entries/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it("always offers not splitting, so auto-detection cannot trap the user", async () => {
    const onChange = vi.fn();
    render(<SplitLevelControl detected={2} applied={2} counts={counts} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /don't split/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('reports the chosen level', async () => {
    const onChange = vi.fn();
    render(<SplitLevelControl detected={2} applied={2} counts={counts} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /H1.*3 entries/i }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('explains itself when nothing repeats, instead of rendering an empty control', () => {
    render(<SplitLevelControl detected={null} applied={null} counts={{}} onChange={vi.fn()} />);
    expect(screen.getByText(/no repeated headings/i)).toBeInTheDocument();
  });
});
