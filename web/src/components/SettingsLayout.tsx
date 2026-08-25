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
import { useRuntime } from '../runtime/RuntimeProvider';
import { useAuthStore } from '../store/auth';

export function SettingsLayout() {
  const { authMode } = useRuntime();
  const isAdmin = useAuthStore((state) => state.user?.isAdmin === true);

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
          {authMode === 'server' && isAdmin && (
            <>
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
              <li>
                <NavLink
                  to="/settings/admin/users"
                  className={({ isActive }) => [
                    'block rounded px-2 py-1.5 text-sm',
                    isActive ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium' : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900',
                  ].join(' ')}
                >
                  Administration
                </NavLink>
              </li>
              <li>
                <NavLink
                  to="/settings/invites"
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
                  Invite codes
                </NavLink>
              </li>
            </>
          )}
          <li>
            <NavLink
              to="/settings/templates"
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
              Templates
            </NavLink>
          </li>
          <li>
            {/* Phase 29 UI-SPEC §F — between Templates and LLM keys.
                Label "Shares" matches the brevity of adjacent items
                (Tokens / Invites / LLM keys / Templates). */}
            <NavLink
              to="/settings/shares"
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
              Shares
            </NavLink>
          </li>
          <li>
            <NavLink
              to="/settings/llm"
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
              LLM keys
            </NavLink>
          </li>
          <li>
            {/* Plan F Task 2 — account-scoped sync remotes. The universe-scoped
                half of sync (links, runs, conflicts) is a tab in universe
                settings, not an item here. */}
            <NavLink
              to="/settings/sync"
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
              Sync
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
