
import { NavLink, Outlet } from 'react-router-dom';
import { useRuntime } from '../runtime/RuntimeProvider';
import { useAuthStore } from '../store/auth';

export function SettingsLayout() {
  const { authMode } = useRuntime();
  const isAdmin = useAuthStore((state) => state.user?.isAdmin === true);

  return (
    <div className="max-w-5xl mx-auto p-6 flex flex-col md:flex-row gap-4 md:gap-8">
      <nav aria-label="Settings sections" className="md:w-48 md:shrink-0">
        <ul className="flex flex-wrap md:flex-col gap-1">
          <li>
            <NavLink
              to="/settings"
              end
              className={({ isActive }) =>
                [
                  'block rounded px-2 py-1.5 text-sm',
                  isActive
                    ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium'
                    : ' text-ink hover:bg-white/[0.03]',
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
                        : ' text-ink hover:bg-white/[0.03]',
                    ].join(' ')
                  }
                >
                  API tokens
                </NavLink>
              </li>
              <li>
                <NavLink
                  to="/settings/users"
                  className={({ isActive }) => [
                    'block rounded px-2 py-1.5 text-sm',
                    isActive ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium' : ' text-ink hover:bg-white/[0.03]',
                  ].join(' ')}
                >
                  Users
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
                        : ' text-ink hover:bg-white/[0.03]',
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
                    : ' text-ink hover:bg-white/[0.03]',
                ].join(' ')
              }
            >
              Templates
            </NavLink>
          </li>
          <li>

            <NavLink
              to="/settings/shares"
              end
              className={({ isActive }) =>
                [
                  'block rounded px-2 py-1.5 text-sm',
                  isActive
                    ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium'
                    : ' text-ink hover:bg-white/[0.03]',
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
                    : ' text-ink hover:bg-white/[0.03]',
                ].join(' ')
              }
            >
              LLM keys
            </NavLink>
          </li>
          <li>

            <NavLink
              to="/settings/sync"
              end
              className={({ isActive }) =>
                [
                  'block rounded px-2 py-1.5 text-sm',
                  isActive
                    ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium'
                    : ' text-ink hover:bg-white/[0.03]',
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
