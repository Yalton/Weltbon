import type { ReactNode } from 'react';

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {body && <p className="mt-2 max-w-md text-sm leading-[1.5] text-neutral-600 dark:text-neutral-400">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
