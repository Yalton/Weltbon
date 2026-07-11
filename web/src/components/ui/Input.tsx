import type { InputHTMLAttributes, Ref } from 'react';

export function Input({
  className = '',
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      {...props}
      className={[
        'w-full rounded-lg bg-white/5 border border-glass-border px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-muted',
        'focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:border-transparent',
        className,
      ].join(' ')}
    />
  );
}
