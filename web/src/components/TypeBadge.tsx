import { TypeStar } from './TypeStar';

export function TypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-ink-secondary">
      <TypeStar type={type} />
      {type}
    </span>
  );
}
