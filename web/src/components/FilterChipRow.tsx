import { useFilterParams } from '../hooks/useFilterParams';
import { useUniverse } from '../hooks/useUniverse';
import { useCategories } from '../hooks/useCategories';
import { FilterChip } from './FilterChip';
import { AddFilterChip } from './AddFilterChip';
import type { FieldRegistryEntry } from '../types/fieldRegistry';

/**
 * Chip row showing every active filter (type, each tag, category, wip,
 * field filters) plus the "+ Filter" trigger.
 *
 * Resolves the category uuid back to its display label via useCategories so
 * the chip reads "Category: Nobles" not the raw id.
 * The special sentinel 'uncategorized' renders as "Category: Uncategorized".
 *
 * Plan 29-04 additions:
 *  - wip chip: "WIP: yes" when wip=true, "WIP: no" when wip=false; remove → wip null
 *  - field filter chips: "{name}: {value}" per entry in fieldFilters; remove → omit that key
 *  - passes universe.fieldRegistry (or []) into AddFilterChip as registeredFields
 */
export function FilterChipRow({ universeId }: { universeId: string }) {
  const [filters, updateFilters] = useFilterParams();
  const { data: universe } = useUniverse(universeId);
  const { data: cats } = useCategories(universeId);

  // Defensive: fieldRegistry may not exist on Universe type until Plan 02 lands.
  // Cast through unknown to avoid TS errors in a parallel-wave scenario.
  const registeredFields: FieldRegistryEntry[] =
    ((universe as unknown as Record<string, unknown>)?.fieldRegistry as FieldRegistryEntry[]) ?? [];

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

  // WIP chip: shown when wip is an explicit boolean (callers may omit the key)
  if (typeof filters.wip === 'boolean') {
    chips.push({
      key: 'wip',
      label: filters.wip ? 'WIP: yes' : 'WIP: no',
      onRemove: () => updateFilters({ wip: null }),
    });
  }

  // Field filter chips: one per active field filter entry
  Object.entries(filters.fieldFilters ?? {}).forEach(([name, value]) => {
    chips.push({
      key: `field:${name}`,
      label: `${name}: ${value}`,
      onRemove: () => {
        const rest = { ...filters.fieldFilters };
        delete rest[name];
        updateFilters({ fieldFilters: rest });
      },
    });
  });

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
        registeredFields={registeredFields}
      />
    </div>
  );
}
