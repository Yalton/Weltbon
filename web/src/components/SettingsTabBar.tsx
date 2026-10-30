import { useSearchParams } from 'react-router-dom';


export interface SettingsTab {
  id: string;
  label: string;
}

export interface SettingsTabBarProps {
  tabs: SettingsTab[];
  defaultTab: string;
}

export function SettingsTabBar({ tabs, defaultTab }: SettingsTabBarProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = searchParams.get('tab') ?? defaultTab;

  return (
    <nav
      role="tablist"
      // Scrolls sideways on narrow screens instead of widening the page. The
      // divider is an inset shadow because a border would sit outside the
      // scroll box and the active tab's underline could no longer cover it.
      className="flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-line)] mb-6"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        // Active vs inactive styling per 26-UI-SPEC §Component Inventory
        const className = active
          ? 'shrink-0 whitespace-nowrap text-sm px-3 py-2 border-b-2 border-[color:var(--color-accent)] text-ink'
          : 'shrink-0 whitespace-nowrap text-sm px-3 py-2 text-ink-secondary hover:text-ink';
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`panel-${tab.id}`}
            aria-current={active ? 'page' : undefined}
            className={className}
            onClick={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('tab', tab.id);
                return next;
              });
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}
