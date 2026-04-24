import type { Severity } from '../hooks/useIssues';

/**
 * Severity color palette — locked per plan 03-09 decision.
 * Colorblind-safe: the text label (not color alone) conveys severity;
 * the color dot is a quick visual cue only and is aria-hidden so screen
 * readers read the text label once.
 */
const COLORS: Record<Severity, string> = {
  critical: 'bg-red-600',
  major: 'bg-orange-500',
  moderate: 'bg-yellow-500',
  minor: 'bg-neutral-500',
};

interface Props {
  severity: Severity;
  /** When false, only the colored dot renders (caller provides its own label). */
  showLabel?: boolean;
}

/**
 * Small pill combining a colored dot + readable severity label.
 * Used in IssuesView rows and the per-entry IssueSection.
 */
export function SeverityPill({ severity, showLabel = true }: Props) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block w-2 h-2 rounded-full ${COLORS[severity]}`}
        aria-hidden="true"
      />
      {showLabel && (
        <span className="text-xs text-neutral-400">{severity}</span>
      )}
    </span>
  );
}
