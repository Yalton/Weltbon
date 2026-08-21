import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * Returns a debounced version of `fn` that waits `ms` after the last call
 * before invoking the underlying function. Cancels its pending timer on
 * unmount so a stale write cannot fire against a torn-down component.
 *
 * Uses `fnRef` so a re-render with a new closure picks up the latest fn
 * without resetting the pending timer.
 *
 * UI-SPEC §13.12: 300 ms is the recommended default for localStorage draft
 * writes; pass it explicitly at the call site.
 *
 * The returned function carries `.cancel()`, which abandons a pending
 * invocation (issue #54). A caller that CLEARS the thing being written — a
 * draft the user just committed or discarded — must cancel first, or the queued
 * write lands afterwards and resurrects it. Unmount cancellation alone does not
 * cover that case: clearing usually happens while the component is still
 * mounted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useDebouncedCallback<F extends (...args: any[]) => unknown>(
  fn: F,
  ms: number,
): ((...args: Parameters<F>) => void) & { cancel: () => void } {
  const fnRef = useRef(fn);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest fn reachable without invalidating the debounced wrapper.
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  // Cancel any pending invocation when the host unmounts.
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const debounced = useCallback(
    (...args: Parameters<F>) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        fnRef.current(...args);
        timerRef.current = null;
      }, ms);
    },
    [ms],
  );

  // Attached rather than returned as a tuple so existing call sites, which
  // call the returned value directly, keep working unchanged.
  return useMemo(
    () => Object.assign(debounced, { cancel }),
    [debounced, cancel],
  );
}
