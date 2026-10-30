import { useEffect, useState } from 'react';
import { useFilterParams } from '../hooks/useFilterParams';
import { Input } from './ui/Input';

const DEBOUNCE_MS = 250;

export function SearchBar() {
  const [filters, updateFilters] = useFilterParams();
  const [local, setLocal] = useState(filters.q);

  // We deliberately ignore the debounced self-write — the URL value IS what
  // we just wrote, so `local === filters.q` and the assignment is a no-op.
  useEffect(() => {
    setLocal(filters.q);
  }, [filters.q]);

  useEffect(() => {
    if (local === filters.q) return;
    const t = setTimeout(() => {
      updateFilters({ q: local });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [local, filters.q, updateFilters]);

  return (
    <Input
      type="search"
      data-testid="search-input"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      placeholder="Search entries..."
      aria-label="Search entries"
    />
  );
}
