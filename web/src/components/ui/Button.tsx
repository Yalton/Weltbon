import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-br from-indigo-400 to-indigo-600 text-white font-semibold ' +
    '[box-shadow:var(--shadow-glow-accent),inset_0_1px_0_rgb(255_255_255/0.25)] ' +
    'hover:from-indigo-300 hover:to-indigo-500',
  ghost:
    'bg-white/5 border border-glass-border text-ink-secondary ' +
    'hover:bg-white/10 hover:text-ink',
  danger:
    'bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25',
};

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ref,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type={type}
      {...props}
      className={cx(
        'rounded-lg px-4 py-2 text-sm transition-colors duration-150',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
        VARIANT_CLASSES[variant],
        className,
      )}
    />
  );
}
