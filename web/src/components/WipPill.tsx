
interface WipPillProps {
  wip: boolean;
  onToggle?: () => void;
  disabled?: boolean;
}

export function WipPill({ wip, onToggle, disabled }: WipPillProps) {
  const pillClasses =
    'inline-flex items-center rounded-full bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400';

  if (onToggle !== undefined) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={wip}
        aria-label={wip ? 'Mark as finished' : 'Mark as WIP'}
        onClick={onToggle}
        disabled={disabled}
        className={`${pillClasses} hover:bg-amber-500/30 disabled:opacity-50`}
      >
        WIP
      </button>
    );
  }

  return (
    <span className={pillClasses} aria-label="Work in progress">
      WIP
    </span>
  );
}
