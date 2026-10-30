
import type { ReactNode } from 'react';

export type StatusFilter = 'all' | 'accepted' | 'rejected' | 'conflicts' | 'warnings';

export type ReviewFilters = {
  status: StatusFilter;
  categories: Set<string>;
  types: Set<string>;
};

interface ImportSidebarFiltersProps {
  filters: ReviewFilters;
  onChange: (next: ReviewFilters) => void;
  availableCategories: Array<{ label: string; count: number }>;
  availableTypes: Array<{ label: string; count: number }>;
  warningCount: number;
  rejectedCount: number;
  onRejectAllWithWarnings: () => void;
  onRejectAllInCategory: () => void;
  onRestoreAllRejected: () => void;
}

const STATUS_OPTIONS: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: 'All entries' },
  { id: 'accepted', label: 'Accepted only' },
  { id: 'rejected', label: 'Rejected only' },
  { id: 'conflicts', label: 'Conflicts only' },
  { id: 'warnings', label: 'With warnings only' },
];

function toggleSet(set: Set<string>, label: string): Set<string> {
  const next = new Set(set);
  if (next.has(label)) {
    next.delete(label);
  } else {
    next.add(label);
  }
  return next;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs uppercase tracking-wide font-medium text-ink-muted mb-2">
      {children}
    </h3>
  );
}

export function ImportSidebarFilters({
  filters,
  onChange,
  availableCategories,
  availableTypes,
  warningCount,
  rejectedCount,
  onRejectAllWithWarnings,
  onRejectAllInCategory,
  onRestoreAllRejected,
}: ImportSidebarFiltersProps) {
  const singleCategorySelected =
    filters.categories.size === 1 ? Array.from(filters.categories)[0] : null;

  return (
    <aside
      role="complementary"
      className="w-56 shrink-0 border-r border-line overflow-y-auto p-4"
    >
      <nav aria-label="Review filters">
        {/* Status (radio) */}
        <section className="first:mt-0">
          <SectionHeading>Status</SectionHeading>
          <ul className="space-y-1">
            {STATUS_OPTIONS.map((opt) => (
              <li key={opt.id}>
                <label className="flex items-center justify-between gap-2 px-2 py-1 rounded cursor-pointer hover:bg-white/5">
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="review-filter-status"
                      value={opt.id}
                      checked={filters.status === opt.id}
                      onChange={() => onChange({ ...filters, status: opt.id })}
                      className="accent-[color:var(--color-accent)]"
                    />
                    <span className="text-sm">{opt.label}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        {/* Category (multi-checkbox) */}
        <section className="mt-6">
          <SectionHeading>Category</SectionHeading>
          <ul className="space-y-1">
            {availableCategories.map((cat) => {
              const checked = filters.categories.has(cat.label);
              return (
                <li key={cat.label}>
                  <label className="flex items-center justify-between gap-2 px-2 py-1 rounded cursor-pointer hover:bg-white/5">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          onChange({
                            ...filters,
                            categories: toggleSet(filters.categories, cat.label),
                          })
                        }
                        className="accent-[color:var(--color-accent)]"
                      />
                      <span className="text-sm">{cat.label}</span>
                    </span>
                    <span className="text-xs text-ink-muted">{cat.count}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Type (multi-checkbox) */}
        <section className="mt-6">
          <SectionHeading>Type</SectionHeading>
          <ul className="space-y-1">
            {availableTypes.map((t) => {
              const checked = filters.types.has(t.label);
              return (
                <li key={t.label}>
                  <label className="flex items-center justify-between gap-2 px-2 py-1 rounded cursor-pointer hover:bg-white/5">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          onChange({
                            ...filters,
                            types: toggleSet(filters.types, t.label),
                          })
                        }
                        className="accent-[color:var(--color-accent)]"
                      />
                      <span className="text-sm">{t.label}</span>
                    </span>
                    <span className="text-xs text-ink-muted">{t.count}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Bulk actions */}
        <section className="mt-6 pt-6 border-t border-line">
          <SectionHeading>Bulk actions</SectionHeading>
          <div className="space-y-2">
            <button
              type="button"
              onClick={onRejectAllWithWarnings}
              disabled={warningCount === 0}
              className="w-full text-left text-sm px-2 py-1 rounded hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Reject all with warnings ({warningCount})
            </button>
            <button
              type="button"
              onClick={onRejectAllInCategory}
              disabled={singleCategorySelected === null}
              className="w-full text-left text-sm px-2 py-1 rounded hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {singleCategorySelected === null
                ? 'Reject all in …'
                : `Reject all in ${singleCategorySelected}`}
            </button>
            <button
              type="button"
              onClick={onRestoreAllRejected}
              disabled={rejectedCount === 0}
              className="w-full text-left text-sm px-2 py-1 rounded hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Restore {rejectedCount} rejected
            </button>
          </div>
        </section>
      </nav>
    </aside>
  );
}
