import type { AuditCategory } from '../hooks/useIssues';

export const EMOJI: Record<AuditCategory, string> = {
  'underdeveloped': '🌱',
  'missing-link': '🔗',
  'contradiction': '⚠️',
  'timeline-inconsistency': '⏱️',
  'dangling-thread': '🧵',
};

export const CATEGORY_STRIPE: Record<AuditCategory, string> = {
  'contradiction': 'border-l-red-400 dark:border-l-red-500',
  'missing-link': 'border-l-blue-400 dark:border-l-blue-500',
  'underdeveloped': 'border-l-emerald-400 dark:border-l-emerald-500',
  'timeline-inconsistency': 'border-l-amber-400 dark:border-l-amber-500',
  'dangling-thread': 'border-l-violet-400 dark:border-l-violet-500',
};

export function CategoryIcon({ category }: { category: AuditCategory | string | undefined }) {
  const emoji = (category && EMOJI[category as AuditCategory]) ?? '•';
  const label = category ?? 'unknown';
  return (
    <span aria-label={label} role="img">
      {emoji}
    </span>
  );
}
