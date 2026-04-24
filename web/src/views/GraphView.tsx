import { EmptyState } from '../components/EmptyState';

/**
 * Placeholder view for /universes/:uid/graph. Plan 08 replaces this with the
 * force-directed graph of entries and links.
 */
export function GraphView() {
  return (
    <EmptyState
      title="Graph view"
      body="Coming in Plan 08 — force-directed graph of entries and links."
    />
  );
}
