import type { ReactNode } from 'react';

/** Small constellation motif above empty-state headings (spec §2). */
function ConstellationMotif() {
  return (
    <svg
      data-testid="empty-state-motif"
      viewBox="0 0 120 48"
      width="120"
      height="48"
      aria-hidden="true"
      className="mb-4 opacity-60"
    >
      <line x1="14" y1="34" x2="44" y2="14" stroke="#a5b4fc" strokeWidth="0.75" opacity="0.4" />
      <line x1="44" y1="14" x2="74" y2="28" stroke="#a5b4fc" strokeWidth="0.75" opacity="0.4" />
      <line x1="74" y1="28" x2="106" y2="10" stroke="#a5b4fc" strokeWidth="0.75" opacity="0.4" />
      <circle cx="14" cy="34" r="2.5" fill="#c7d2fe" opacity="0.8" />
      <circle cx="44" cy="14" r="3.5" fill="#818cf8" />
      <circle cx="74" cy="28" r="2" fill="#c7d2fe" opacity="0.7" />
      <circle cx="106" cy="10" r="2.5" fill="#c7d2fe" opacity="0.8" />
    </svg>
  );
}

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
      <ConstellationMotif />
      <h2 className="font-display text-xl font-semibold tracking-tight text-ink">{title}</h2>
      {body && (
        <p className="mt-2 max-w-md text-sm leading-[1.5] text-ink-secondary">{body}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
