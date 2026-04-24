import { EmptyState } from '../components/EmptyState';

/**
 * Placeholder view for /universes/:uid/issues. Plan 09 replaces this with
 * the issue list + severity filtering UI.
 */
export function IssuesView() {
  return (
    <EmptyState
      title="Issues"
      body="Coming in Plan 09 — list of open issues and TODOs across this universe."
    />
  );
}
