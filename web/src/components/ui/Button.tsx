import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'btn-accent font-semibold',
  ghost:
    'bg-transparent border border-line-strong text-ink-secondary ' +
    'enabled:hover:bg-white/5 enabled:hover:text-ink',
  danger:
    'bg-transparent border border-line-strong text-rose-300 ' +
    'enabled:hover:bg-rose-500/10 enabled:hover:border-rose-400/40',
};

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-2 text-sm transition-colors duration-150 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-canvas-mid)]';

/** Button styling for elements that are not <button>, such as a router Link. */
export function buttonClasses(variant: ButtonVariant = 'primary', className = ''): string {
  return cx(BASE_CLASSES, VARIANT_CLASSES[variant], className);
}

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
      className={buttonClasses(variant, className)}
    />
  );
}
