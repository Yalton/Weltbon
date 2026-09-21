import { useCallback, useEffect, useMemo, useRef } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useDebouncedCallback<F extends (...args: any[]) => unknown>(
  fn: F,
  ms: number,
): ((...args: Parameters<F>) => void) & { cancel: () => void } {
  const fnRef = useRef(fn);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

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

  return useMemo(
    () => Object.assign(debounced, { cancel }),
    [debounced, cancel],
  );
}
