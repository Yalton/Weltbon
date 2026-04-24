import { useEffect, useState } from 'react';
import { useFilterParams } from '../hooks/useFilterParams';

const DEBOUNCE_MS = 250;

/**
 * Debounced search input bound to the URL's ?q= param via useFilterParams.
 *
 * Local state owns the input value for immediate responsiveness; a 250ms
 * setTimeout syncs the value into the URL. If the URL changes externally
 * (back button, chip cleared from elsewhere) the local state resyncs via a
 * second effect so the input never drifts from the source of truth.
 */
export function SearchBar() {
  const [filters, updateFilters] = useFilterParams();
  const [local, setLocal] = useState(filters.q);

  // Resync local when the URL q changes externally (not from this input).
  // We deliberately ignore the debounced self-write — the URL value IS what
  // we just wrote, so `local === filters.q` and the assignment is a no-op.
  useEffect(() => {
    setLocal(filters.q);
  }, [filters.q]);

  // Debounce local → URL.
  useEffect(() => {
    if (local === filters.q) return;
    const t = setTimeout(() => {
      updateFilters({ q: local });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [local, filters.q, updateFilters]);

  return (
    <input
      type="search"
      data-testid="search-input"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      placeholder="Search entries..."
      aria-label="Search entries"
      className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
    />
  );
}
