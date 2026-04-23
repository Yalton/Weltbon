const TYPE_CLASSES: Record<string, string> = {
  concept:
    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  entity:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  location:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  event:
    'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  faction:
    'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  artifact:
    'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
  species:
    'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  culture:
    'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300',
  thread:
    'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
};

const FALLBACK =
  'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';

export function TypeBadge({ type }: { type: string }) {
  const colors = TYPE_CLASSES[type.toLowerCase()] ?? FALLBACK;

  return (
    <span className={`inline-block shrink-0 rounded-full px-2 py-1 text-sm font-semibold ${colors}`}>
      {type}
    </span>
  );
}
