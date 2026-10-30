export function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-raised text-ink px-3 py-1 text-sm">
      <span>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="text-ink-secondary hover:text-white leading-none"
      >
        ×
      </button>
    </span>
  );
}
