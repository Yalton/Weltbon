import { forwardRef, useEffect, useRef, useState } from 'react';
import { ImportProgressBar } from './ImportProgressBar';

/**
 * Commit-phase progress shell wrapping ImportProgressBar (Plan 12-05) with
 * a deterministic-fill timer and aria-live announcement per UI-SPEC §6.6 and
 * §9.3.
 *
 * The wrapper is focusable (tabindex=-1) so the parent (Plan 12-06
 * IngestImport) can focus-shift to it on commit start via forwardRef. The
 * inner <ImportProgressBar> renders the actual progressbar role; the wrapper
 * provides redundant aria-live="polite" coverage.
 *
 * Timer recipe (mirrors ImportUploadStep.tsx:198-212): 50 ms tick, capped at
 * 90% until the parent flips `done` to true. ImportProgressBar's structural
 * override jumps the inner fill to 100% on done=true.
 *
 * Static Tailwind class strings only — no template-string concat (Tailwind v4).
 */
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
