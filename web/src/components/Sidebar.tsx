import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useCategories } from '../hooks/useCategories';

function SidebarNavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
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
      {children}
    </NavLink>
  );
}

export function Sidebar({ universeId }: { universeId: string }) {
  const { data, isLoading, error } = useCategories(universeId);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <nav
      aria-label="Universe navigation"
      className="w-64 shrink-0 border-r border-neutral-200 dark:border-neutral-800 h-full overflow-y-auto py-4"
    >
      <div className="px-3 pb-3 border-b border-neutral-200 dark:border-neutral-800 space-y-1">
        <SidebarNavLink to={`/universes/${universeId}/entries`}>Entries</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/graph`}>Graph</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/issues`}>Issues</SidebarNavLink>
      </div>

      <div className="mt-4 px-3">
        <h3 className="text-xs uppercase tracking-wide text-neutral-500">Categories</h3>

        {isLoading && (
          <p className="text-sm mt-2 text-neutral-500">Loading…</p>
        )}
        {error && (
          <p className="text-sm mt-2 text-red-500">Failed to load</p>
        )}

        {data && (
          <ul className="mt-2 space-y-0.5" data-testid="category-list">
            {data.categories.map((c) => {
              const isCollapsed = !!collapsed[c.id];
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    data-collapsed={isCollapsed ? 'true' : 'false'}
                    className="w-full flex items-center justify-between py-1 px-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-900 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="w-3 inline-block text-neutral-400">
                        {isCollapsed ? '▸' : '▾'}
                      </span>
                      {c.icon && <span aria-hidden>{c.icon}</span>}
                      <span>{c.label}</span>
                    </span>
                    <span className="text-neutral-500 tabular-nums">{c.entryCount}</span>
                  </button>
                </li>
              );
            })}
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
