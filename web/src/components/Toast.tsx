import { useEffect } from 'react';

type Variant = 'success' | 'error';

interface Props {
  message: string;
  variant?: Variant;
  onDismiss: () => void;
  /** Auto-dismiss duration in milliseconds. Defaults to 4000ms (UI-SPEC §6.7). */
  durationMs?: number;
}

/**
 * Bottom-anchored toast notification with success/error variants.
 *
 * Lifted from EntryList.tsx:124-128 (existing inline error toast) plus
 * EntryList.tsx:24-29 (auto-dismiss timer). Keeps static class strings only
 * (no `bg-${variant}-600` template strings) so Tailwind v4 picks them up.
 *
 * UI-SPEC §13.4: shared component used by both EntryList (error variant for
 * export failures) and the post-commit success toast in Plan 12-06.
 */
export function Toast({ message, variant = 'success', onDismiss, durationMs = 4000 }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [onDismiss, durationMs]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'fixed bottom-4 left-1/2 -translate-x-1/2 text-sm px-4 py-2 rounded-md shadow-lg z-50',
        variant === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white',
      ].join(' ')}
    >
      {message}
    </div>
  );
}
