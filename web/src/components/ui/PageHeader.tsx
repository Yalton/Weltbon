import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
      <h1 className="font-display text-2xl font-semibold text-ink">{title}</h1>
      {subtitle && <span className="text-sm text-ink-muted">{subtitle}</span>}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
