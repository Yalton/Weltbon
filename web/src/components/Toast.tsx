import { useEffect } from 'react';

type Variant = 'success' | 'error';

interface Props {
  message: string;
  variant?: Variant;
  onDismiss: () => void;
  durationMs?: number;
}

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
