
export type Precision = 'exact' | 'approximate' | 'era';

export function precisionDotClass(p: Precision): string {
  const base = 'inline-block w-2 h-2 rounded-full';
  switch (p) {
    case 'era':
      return `${base} bg-[color:var(--color-accent)]`;
    case 'approximate':
      return `${base} bg-neutral-400`;
    case 'exact':
    default:
      return `${base} bg-neutral-200 dark:bg-neutral-300`;
  }
}

export function PrecisionBadge({ precision }: { precision: Precision }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={precisionDotClass(precision)} />
      <span className="text-xs text-ink-muted">{precision}</span>
    </span>
  );
}
