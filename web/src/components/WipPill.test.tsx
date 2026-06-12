import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WipPill } from './WipPill';

describe('WipPill (non-interactive)', () => {
  it('renders a span with text "WIP" and aria-label "Work in progress" when no onToggle', () => {
    render(<WipPill wip={true} />);
    const pill = screen.getByLabelText('Work in progress');
    expect(pill.tagName.toLowerCase()).toBe('span');
    expect(pill).toHaveTextContent('WIP');
  });

  it('also renders the non-interactive variant when wip=false and no onToggle', () => {
    render(<WipPill wip={false} />);
    const pill = screen.getByLabelText('Work in progress');
    expect(pill.tagName.toLowerCase()).toBe('span');
    expect(pill).toHaveTextContent('WIP');
  });
});

describe('WipPill (interactive)', () => {
  it('renders a button with role="switch" when onToggle is provided', () => {
    const onToggle = vi.fn();
    render(<WipPill wip={true} onToggle={onToggle} />);
    const btn = screen.getByRole('switch');
    expect(btn.tagName.toLowerCase()).toBe('button');
  });

  it('button aria-checked reflects the wip prop', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<WipPill wip={true} onToggle={onToggle} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    rerender(<WipPill wip={false} onToggle={onToggle} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('aria-label is "Mark as finished" when wip=true', () => {
    const onToggle = vi.fn();
    render(<WipPill wip={true} onToggle={onToggle} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-label', 'Mark as finished');
  });

  it('aria-label is "Mark as WIP" when wip=false', () => {
    const onToggle = vi.fn();
    render(<WipPill wip={false} onToggle={onToggle} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-label', 'Mark as WIP');
  });

  it('clicking the interactive WipPill calls onToggle once', async () => {
    const onToggle = vi.fn();
    render(<WipPill wip={true} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
