import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export function Panel({
  hover = false,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      {...props}
      className={cx(
        'rounded-lg bg-panel border border-line',
        hover && 'transition-colors duration-150 hover:bg-raised hover:border-line-strong',
        className,
      )}
    />
  );
}
