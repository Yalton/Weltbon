import { cx } from './cx';

export function Loading({
  label = 'Loading…',
  fullPage = false,
  className = '',
}: {
  label?: string;
  fullPage?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cx(
        'flex flex-col items-center justify-center gap-3 text-ink-muted',
        fullPage ? 'min-h-[60vh] w-full' : 'min-h-[8rem] w-full py-8',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="animate-spinner h-8 w-8 rounded-full border-2 border-glass-border border-t-[color:var(--color-accent-strong)]"
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
