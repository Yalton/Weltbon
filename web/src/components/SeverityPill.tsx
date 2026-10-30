import type { Severity } from '../hooks/useIssues';

const COLORS: Record<Severity, string> = {
  critical: 'bg-red-600',
  major: 'bg-orange-500',
  moderate: 'bg-yellow-500',
  minor: 'bg-ink-muted',
};

interface Props {
  severity: Severity;
  showLabel?: boolean;
}

export function SeverityPill({ severity, showLabel = true }: Props) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block w-2 h-2 rounded-full ${COLORS[severity]}`}
        aria-hidden="true"
      />
      {showLabel && (
        <span className="text-xs text-ink-muted">{severity}</span>
      )}
    </span>
  );
}
