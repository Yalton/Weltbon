import { useFilterParams } from '../hooks/useFilterParams';
import { useUniverse } from '../hooks/useUniverse';
import { useCategories } from '../hooks/useCategories';
import { FilterChip } from './FilterChip';
import { AddFilterChip } from './AddFilterChip';

/**
 * Chip row showing every active filter (type, each tag, category) plus the
 * "+ Filter" trigger. Resolves the category uuid back to its display label
 * via useCategories so the chip reads "Category: Nobles" not the raw id.
 * The special sentinel 'uncategorized' renders as "Category: Uncategorized".
 */
export function FilterChipRow({ universeId }: { universeId: string }) {
  const [filters, updateFilters] = useFilterParams();
  const { data: universe } = useUniverse(universeId);
  const { data: cats } = useCategories(universeId);

  const chips: { key: string; label: string; onRemove: () => void }[] = [];
  if (filters.type) {
    chips.push({
      key: 'type',
      label: `Type: ${filters.type}`,
      onRemove: () => updateFilters({ type: null }),
    });
  }
  filters.tags.forEach((tag) => {
    chips.push({
      key: `tag:${tag}`,
      label: `Tag: ${tag}`,
      onRemove: () =>
        updateFilters({ tags: filters.tags.filter((t) => t !== tag) }),
    });
  });
  if (filters.category) {
    const catName =
      filters.category === 'uncategorized'
        ? 'Uncategorized'
        : cats?.categories.find((c) => c.id === filters.category)?.label ?? 'Category';
    chips.push({
      key: 'category',
      label: `Category: ${catName}`,
      onRemove: () => updateFilters({ category: null }),
    });
  }

  return (
    <div
      className="flex flex-wrap gap-2 items-center"
      data-testid="filter-chip-row"
    >
      {chips.map((c) => (
        <FilterChip key={c.key} label={c.label} onRemove={c.onRemove} />
      ))}
      <AddFilterChip
        universeId={universeId}
        filters={filters}
        updateFilters={updateFilters}
        types={universe?.entryTypes ?? []}
        categories={cats?.categories ?? []}
      />
    </div>
  );
}
