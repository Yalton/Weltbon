
export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  labelId: string;
  title?: string;
}

export function Toggle({ checked, onChange, disabled, labelId, title }: ToggleProps) {
  const trackBg = checked
    ? 'bg-[color:var(--color-accent)]'
    : 'bg-neutral-300 dark:bg-neutral-700';
  const disabledClasses = disabled ? 'opacity-50 cursor-not-allowed' : '';
  const trackClass = `relative inline-flex w-10 h-6 rounded-full transition-colors duration-150 ${trackBg} ${disabledClasses} focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2`;
  const thumbTranslate = checked ? 'translate-x-4' : 'translate-x-0.5';
  const thumbClass = `absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transform transition-transform duration-150 motion-reduce:transition-none ${thumbTranslate}`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={title}
      className={trackClass}
    >
      <span aria-hidden="true" className={thumbClass} />
    </button>
  );
}
