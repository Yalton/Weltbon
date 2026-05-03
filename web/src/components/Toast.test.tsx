import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toast } from './Toast';

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the message text', () => {
    render(<Toast message="Hello" onDismiss={() => {}} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('default variant=success uses bg-emerald-600 class', () => {
    render(<Toast message="Imported" onDismiss={() => {}} />);
    const node = screen.getByRole('status');
    expect(node.className).toMatch(/bg-emerald-600/);
    expect(node.className).not.toMatch(/bg-red-600/);
  });

  it('variant=error uses bg-red-600 class', () => {
    render(<Toast message="Boom" variant="error" onDismiss={() => {}} />);
    const node = screen.getByRole('status');
    expect(node.className).toMatch(/bg-red-600/);
    expect(node.className).not.toMatch(/bg-emerald-600/);
  });

  it('exposes role=status and aria-live=polite', () => {
    render(<Toast message="Saved" onDismiss={() => {}} />);
    const node = screen.getByRole('status');
    expect(node).toHaveAttribute('aria-live', 'polite');
  });

  it('calls onDismiss after the default 4000ms duration', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Saved" onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('respects a custom durationMs', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Quick" onDismiss={onDismiss} durationMs={1000} />);
    vi.advanceTimersByTime(999);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clears the timer on unmount (no late onDismiss call)', () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<Toast message="Bye" onDismiss={onDismiss} durationMs={2000} />);
    vi.advanceTimersByTime(1000);
    unmount();
    vi.advanceTimersByTime(5000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
