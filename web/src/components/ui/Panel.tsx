import type { HTMLAttributes } from 'react';
import { cx } from './cx';

/**
 * Glass surface (spec §1.1 --surface-glass). `hover` adds the interactive
 * glow treatment used by cards that navigate somewhere.
 */
export function Panel({
  hover = false,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      {...props}
      className={cx(
        'rounded-[10px] bg-glass border border-glass-border backdrop-blur-[5px]',
        hover &&
          'transition-all duration-150 hover:bg-white/10 hover:border-indigo-300/25 hover:shadow-glow-soft',
        className,
      )}
    />
  );
}
