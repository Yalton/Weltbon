/**
 * Phase 26 — custom on/off toggle (button role="switch") for the AI Gap
 * Auditor opt-in row in UniverseSettings (Plan 06).
 *
 * Not a native checkbox because the visual design is a sliding-thumb pill
 * (UI-SPEC §Interaction States Toggle pattern) and styling a checkbox to
 * match would require either appearance:none hackery or an icon swap. A
 * `<button role="switch" aria-checked>` carries the same accessibility
 * semantics with simpler markup.
 *
 * Motion: thumb slide uses `transition-transform duration-150` paired with
 * `motion-reduce:transition-none` so users with prefers-reduced-motion get
 * an instant flip (UI-SPEC §Motion).
 */

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** ID of the visible label element (aria-labelledby target). */
  labelId: string;
  /**
   * Optional native tooltip — Phase 29 UI-SPEC §B requires a contextual
   * `title` attribute on the Public toggle that swaps between off/on
   * states ("Make this entry visible in shared views" vs "This entry is
   * visible in shared views"). Pre-existing AI Gap Auditor toggle does
   * not set this, preserving its current no-tooltip behavior.
   */
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
