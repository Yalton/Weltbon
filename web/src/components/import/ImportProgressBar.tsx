/**
 * Linear progress bar for the Phase 12 import flow.
 *
 * Per UI-SPEC §6.6 — h-1 neutral track with accent fill, transition-all
 * duration-150 on the inner fill so a smooth animation carries the bar from
 * its current width to the next one. The locked done-override semantics:
 * when `done` is true, the inner fill jumps to 100% width regardless of pct
 * ("if response arrives before progress bar fills, jump to 100% immediately
 * and skip remaining ease"). Because the parent stops issuing pct updates at
 * the same moment it sets done=true, the only outstanding transition is the
 * one to 100%.
 *
 * Pure presentational — no internal state, no effects. Used by both the
 * upload-step (parse progress) and the integration view (commit progress).
 */
export interface ImportProgressBarProps {
  pct: number;
  done: boolean;
  ariaLabel?: string;
}

export function ImportProgressBar({
  pct,
  done,
  ariaLabel = 'Upload progress',
}: ImportProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, pct));
  const width = done ? 100 : clamped;
  return (
    <div
      role="progressbar"
      aria-valuenow={width}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
      className="h-1 mt-4 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden"
    >
      <div
        className="h-full bg-[color:var(--color-accent)] transition-all duration-150"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
