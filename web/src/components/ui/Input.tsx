import type { InputHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

export function Input({
  className = '',
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      {...props}
      className={cx(
        'w-full rounded-md bg-canvas-lo border border-line-strong px-3 py-2 text-sm text-ink',
        'placeholder:text-ink-muted',
        'focus:outline-none focus:border-[color:var(--color-accent)] focus:ring-2 focus:ring-[color:var(--color-accent-soft)]',
        className,
      )}
    />
  );
}
