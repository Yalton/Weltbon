/**
 * AIBadge — neutral-grey "AI" pill per D-06.
 *
 * Source-signal is orthogonal to category signal (D-06): this badge never
 * takes a color prop. Renders next to the existing SeverityPill on AI rows
 * in IssuesView and IssueSection.
 */
export function AIBadge() {
  return (
    <span
      className="inline-flex items-center rounded-full bg-neutral-200 dark:bg-neutral-700 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:text-neutral-300"
      aria-label="AI-generated suggestion"
    >
      AI
    </span>
  );
}
