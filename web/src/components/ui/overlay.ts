
export const dialogOverlayClasses =
  'fixed inset-0 bg-black/60 backdrop-blur-[2px] z-40 ' +
  'data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out';

export const dialogContentClasses =
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full z-50 ' +
  'bg-[color:var(--color-overlay)] backdrop-blur-md border border-white/10 ' +
  'rounded-xl p-6 shadow-ambient focus:outline-none ' +
  'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out';

export const dialogTitleClasses = 'font-display text-lg font-semibold text-ink';

export const menuContentClasses =
  'bg-[color:var(--color-overlay)] backdrop-blur-md border border-white/10 ' +
  'rounded-lg p-1 min-w-[160px] shadow-ambient z-50 ' +
  'data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out';

export const menuItemClasses =
  'px-3 py-1.5 text-sm rounded-md cursor-pointer outline-none text-ink-secondary ' +
  'data-[highlighted]:bg-white/10 data-[highlighted]:text-ink';

export const menuItemDangerClasses =
  'px-3 py-1.5 text-sm rounded-md cursor-pointer outline-none text-rose-300 ' +
  'data-[highlighted]:bg-rose-500/15 data-[highlighted]:text-rose-200';

export const menuSeparatorClasses = 'my-1 h-px bg-white/10';
