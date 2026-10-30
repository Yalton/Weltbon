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
      className="h-1 mt-4 bg-raised rounded-full overflow-hidden"
    >
      <div
        className="h-full bg-[color:var(--color-accent)] transition-all duration-150"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
