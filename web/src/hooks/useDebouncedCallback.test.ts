import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDebouncedCallback } from './useDebouncedCallback';

describe('useDebouncedCallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces multiple rapid calls into a single underlying invocation', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 300));

    for (let i = 0; i < 5; i++) {
      result.current(i);
      vi.advanceTimersByTime(20); // 5 calls within 100ms
    }
    // Still inside the debounce window — no underlying call yet.
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(4); // last args win
  });

  it('does not fire before the configured ms elapse', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 300));
    result.current('arg');
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('arg');
  });

  it('does not fire after unmount', () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 300));
    result.current();
    vi.advanceTimersByTime(100);
    unmount();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('uses the latest fn after a re-render (fnRef freshness)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ fn }: { fn: (...a: unknown[]) => void }) => useDebouncedCallback(fn, 200),
      { initialProps: { fn: first } },
    );

    result.current('hello');
    rerender({ fn: second });
    vi.advanceTimersByTime(200);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('hello');
  });

  // ── issue #54 ───────────────────────────────────────────────────────────────
  // A pending write must be abandonable. Without this, a caller that clears the
  // thing being written (a draft the user just committed or discarded) has a
  // save still in flight, which lands ~ms later and resurrects it — the user
  // then sees a resumable draft for work they already finished.
  it('cancel() abandons a pending invocation', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 300));

    result.current('doomed');
    result.current.cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel() is safe with nothing pending, and does not disable later calls', () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 300));

    result.current.cancel(); // nothing queued — must not throw

    result.current('later');
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('later');
  });
});
