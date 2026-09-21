import { useFilterParams } from '../hooks/useFilterParams';
import { useUniverse } from '../hooks/useUniverse';
import { useCategories } from '../hooks/useCategories';
import { useEntries } from '../hooks/useEntries';
import { FilterChip } from './FilterChip';
import { AddFilterChip } from './AddFilterChip';

export function FilterChipRow({ universeId }: { universeId: string }) {
  const [filters, updateFilters] = useFilterParams();
  const { data: universe } = useUniverse(universeId);
  const { data: cats } = useCategories(universeId);
  const { data: entries = [], isFetched: entriesFetched } = useEntries(universeId);

  const registeredFields = universe?.fieldRegistry ?? [];

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

  if (typeof filters.wip === 'boolean') {
    chips.push({
      key: 'wip',
      label: filters.wip ? 'WIP: yes' : 'WIP: no',
      onRemove: () => updateFilters({ wip: null }),
    });
  }

  // Field-filter chips — one per active fieldFilters entry. For entry-ref fields
  // the stored value is the target entry's UUID (D-01); resolve it back to the
  // title so the chip never leaks a raw UUID into the UI (D-07). Fall back to a
  Object.entries(filters.fieldFilters ?? {}).forEach(([name, value]) => {
    const field = registeredFields.find(
      (f) => f.name.toLowerCase() === name.toLowerCase(),
    );
    let display = value;
    if (field?.type === 'entry-ref') {
      const target = entries.find((e) => e.id === value);
      display = target ? target.title : entriesFetched ? 'Deleted entry' : '…';
    }
    chips.push({
      key: `field:${name}`,
      label: `${name}: ${display}`,
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
