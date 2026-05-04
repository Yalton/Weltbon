import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { ImportCommitProgress } from '../ImportCommitProgress';

describe('ImportCommitProgress', () => {
  beforeEach(() => {
    // Mock performance.now() too so the deterministic-fill timer's
    // `performance.now() - startedAt` math advances when fake timers tick.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function getInnerFill(): HTMLDivElement {
    const bar = screen.getByRole('progressbar');
    const fill = bar.firstElementChild as HTMLDivElement | null;
    if (!fill) throw new Error('Inner fill not found');
    return fill;
  }

  it('renders with the wrapper marked aria-live=polite and tabindex=-1', () => {
    render(<ImportCommitProgress entryCount={1} done={false} />);
    const wrapper = screen.getByRole('progressbar').parentElement as HTMLDivElement;
    expect(wrapper).toHaveAttribute('aria-live', 'polite');
    expect(wrapper).toHaveAttribute('tabindex', '-1');
  });

  it('forwardRef yields the wrapper div', () => {
    const ref = createRef<HTMLDivElement>();
    render(<ImportCommitProgress ref={ref} entryCount={1} done={false} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.getAttribute('aria-live')).toBe('polite');
  });

  it('drives pct linearly toward 90% over the estimated duration', () => {
    render(<ImportCommitProgress entryCount={10} done={false} />);
    // Advance roughly halfway through the 500ms estimate.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const widthMid = parseFloat(getInnerFill().style.width);
    expect(widthMid).toBeGreaterThan(0);
    expect(widthMid).toBeLessThan(90);
    // Past the estimate.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(parseFloat(getInnerFill().style.width)).toBeLessThanOrEqual(90);
  });

  it('jumps to 100% when done flips to true', () => {
    const { rerender } = render(<ImportCommitProgress entryCount={5} done={false} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(<ImportCommitProgress entryCount={5} done={true} />);
    expect(getInnerFill().style.width).toBe('100%');
  });

  it('does not throw after unmount when timers continue to advance', () => {
    const { unmount } = render(<ImportCommitProgress entryCount={5} done={false} />);
    unmount();
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(1000);
      }),
    ).not.toThrow();
  });

  it('honors a custom ariaLabel', () => {
    render(<ImportCommitProgress entryCount={1} done={false} ariaLabel="Saving import" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', 'Saving import');
  });
});
