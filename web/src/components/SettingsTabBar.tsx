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
      className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800 mb-6"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        // Active vs inactive styling per 26-UI-SPEC §Component Inventory
        // SettingsTabBar. `-mb-px` makes the active tab's bottom border sit
        const className = active
          ? 'text-sm px-3 py-2 border-b-2 border-[color:var(--color-accent)] text-neutral-900 dark:text-neutral-100 -mb-px'
          : 'text-sm px-3 py-2 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100';
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
