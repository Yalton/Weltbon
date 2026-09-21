import { forwardRef, useEffect, useRef, useState } from 'react';
import { ImportProgressBar } from './ImportProgressBar';

interface ImportCommitProgressProps {
  entryCount: number;
  done: boolean;
  ariaLabel?: string;
}

export const ImportCommitProgress = forwardRef<HTMLDivElement, ImportCommitProgressProps>(
  function ImportCommitProgress({ entryCount, done, ariaLabel = 'Commit progress' }, ref) {
    const [pct, setPct] = useState(0);
    const timerRef = useRef<number | null>(null);

    useEffect(() => {
      const estimatedMs = Math.max(500, entryCount * 50);
      const startedAt = performance.now();
      function tick() {
        const elapsed = performance.now() - startedAt;
        const linearPct = Math.min(90, (elapsed / estimatedMs) * 90);
        setPct(linearPct);
        if (elapsed < estimatedMs) {
          timerRef.current = window.setTimeout(tick, 50);
        }
      }
      tick();
      return () => {
        if (timerRef.current != null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };
    }, [entryCount]);

    useEffect(() => {
      if (done && timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }, [done]);

    return (
      <div ref={ref} tabIndex={-1} aria-live="polite" className="focus:outline-none">
        <ImportProgressBar pct={pct} done={done} ariaLabel={ariaLabel} />
      </div>
    );
  },
);
