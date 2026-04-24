import { entryTypeColor } from '../lib/entryTypeColor';

export function TypeBadge({ type }: { type: string }) {
  const colors = entryTypeColor(type);

  return (
    <span className={`inline-block shrink-0 rounded-full px-2 py-1 text-sm font-semibold ${colors}`}>
      {type}
    </span>
  );
}
