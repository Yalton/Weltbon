/**
 * Small presentational chip used by FilterChipRow. Neutral styling matches
 * the rest of the app's dark/light surfaces; the × button gets an explicit
 * `aria-label` so assistive tech + tests can target "Remove {label}".
 */
export function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-neutral-200 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 px-3 py-1 text-sm">
      <span>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white leading-none"
      >
        ×
      </button>
    </span>
  );
}
