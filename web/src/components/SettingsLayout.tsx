/**
 * SettingsLayout — vertical left-rail sub-nav for /settings pages.
 *
 * Per UI-SPEC §4.2-4.5:
 * - Desktop (md+): flex row, w-48 nav rail left, flex-1 main right
 * - Mobile (<md): flex col, horizontal pill row of links stacked above content
 *
 * Active state mirrors Sidebar.tsx SidebarNavLink pattern (UI-SPEC §4.3).
 */

import { NavLink, Outlet } from 'react-router-dom';

export function SettingsLayout() {
  return (
    <div className="max-w-5xl mx-auto p-6 flex flex-col md:flex-row gap-4 md:gap-8">
      <nav aria-label="Settings sections" className="md:w-48 md:shrink-0">
        <ul className="flex md:flex-col gap-1">
          <li>
            <NavLink
              to="/settings"
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
              Visual
            </NavLink>
          </li>
          <li>
            <NavLink
              to="/settings/tokens"
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
              API tokens
            </NavLink>
          </li>
        </ul>
      </nav>
      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
