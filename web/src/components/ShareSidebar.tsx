import { NavLink } from 'react-router-dom';
import { useCategories } from '../hooks/useCategories';
import { Loading } from './ui/Loading';

/**
 * Read-only share-mode sidebar mirroring `Sidebar.tsx` structure without any
 * auth chrome or mutation affordances. Per UI-SPEC §A ShareSidebar spec:
 *
 *  - 256px width matching the authenticated Sidebar (visual continuity).
 *  - Three NavLinks scoped to `/share/${token}{,/graph,/timeline}` — same
 *    active/inactive accent-tint styling as the authenticated SidebarNavLink.
 *  - Category list rendered name + count READ-ONLY:
 *    no `+ New`, no rename / delete kebab, no drag-to-reorder handle,
 *    no `CategorySidebarItem` (its DOM contains mutation triggers we must
 *    DOM-omit, not just CSS-hide).
 *  - No UserMenu, no Settings link, no Issues nav (UI-SPEC §A Kept-affordances
 *    table: Issues is hidden in share mode entirely).
 *
 * Category data flows through `useCategories(token)` — but inside ShareLayout
 * the `setShareToken` seam from Task 1 routes the request through
 * `/api/share/categories`, so the `token` value passed here is incidental
 * (it satisfies the hook's `enabled` guard and serves as the React Query
 * cache key). The hook fetches `/universes/<token>/categories` and the
 * client seam translates it to `/api/share/categories`.
 */
export function ShareSidebar({ token }: { token: string }) {
  const { data, isLoading, error } = useCategories(token);

  return (
    <nav
      aria-label="Share navigation"
      className="w-64 shrink-0 border-r border-neutral-200 dark:border-neutral-800 h-full overflow-y-auto py-4"
    >
      <div className="px-3 pb-3 border-b border-neutral-200 dark:border-neutral-800 space-y-1">
        <NavLink
          to={`/share/${token}`}
          end
          className={({ isActive }) =>
            [
              'block rounded px-2 py-1.5 text-sm',
              isActive
                ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium'
                : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900',
            ].join(' ')
          }
        >
          Entries
        </NavLink>
        <NavLink
          to={`/share/${token}/graph`}
          end
          className={({ isActive }) =>
            [
              'block rounded px-2 py-1.5 text-sm',
              isActive
                ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium'
                : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900',
            ].join(' ')
          }
        >
          Graph
        </NavLink>
        <NavLink
          to={`/share/${token}/timeline`}
          end
          className={({ isActive }) =>
            [
              'block rounded px-2 py-1.5 text-sm',
              isActive
                ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium'
                : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900',
            ].join(' ')
          }
        >
          Timeline
        </NavLink>
        {/* Phase 40 Plan 04 — share-mode maps nav link */}
        <NavLink
          to={`/share/${token}/maps`}
          className={({ isActive }) =>
            [
              'block rounded px-2 py-1.5 text-sm',
              isActive
                ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium'
                : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900',
            ].join(' ')
          }
        >
          Maps
        </NavLink>
      </div>

      <div className="mt-4 px-3">
        <h3 className="text-xs uppercase tracking-wide text-neutral-500">Categories</h3>

        {isLoading && (
          <Loading />
        )}
        {error && (
          <p className="text-sm mt-2 text-red-500">Failed to load</p>
        )}

        {data && data.categories.length === 0 && (
          <ul className="mt-2 space-y-0.5" data-testid="share-category-list">
            <li>
              <div className="flex items-center justify-between py-1 px-2 text-sm text-neutral-500">
                <span className="pl-5">Uncategorized</span>
                <span className="tabular-nums">{data.uncategorizedCount}</span>
              </div>
            </li>
          </ul>
        )}

        {data && data.categories.length > 0 && (
          <ul className="mt-2 space-y-0.5" data-testid="share-category-list">
            {data.categories.map((c) => (
              <li key={c.id}>
                {/*
                  Read-only category row: name + count, NO collapse chevron
                  (visitors cannot persist collapse state), NO kebab, NO
                  drag handle. We render a plain non-interactive row instead
                  of `<CategorySidebarItem readOnly={true} />` because the
                  authenticated item is a wrapper around mutation triggers
                  whose DOM/JS we don't want to load on the visitor surface
                  at all (UI-SPEC §A — "DOM-omit, not just CSS-hide").
                */}
                <div className="flex items-center gap-2 py-1 px-2 text-sm">
                  <span aria-hidden className="w-3 inline-block" />
                  {c.icon && <span aria-hidden>{c.icon}</span>}
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-neutral-500 tabular-nums pr-1">
                    {c.entryCount}
                  </span>
                </div>
              </li>
            ))}
            <li>
              <div className="flex items-center justify-between py-1 px-2 text-sm text-neutral-500">
                <span className="pl-5">Uncategorized</span>
                <span className="tabular-nums">{data.uncategorizedCount}</span>
              </div>
            </li>
          </ul>
        )}
      </div>
    </nav>
  );
}
