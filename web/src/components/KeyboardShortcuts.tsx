import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { dialogContentClasses, dialogOverlayClasses, dialogTitleClasses } from './ui/overlay';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

const SHORTCUTS: Array<{ group: string; items: Array<[keys: string[], label: string]> }> = [
  { group: 'Anywhere', items: [[['?'], 'Show this list'], [['Esc'], 'Close a dialog or menu']] },
  {
    group: 'Entry editor',
    items: [
      [[MOD, 'B'], 'Bold'],
      [[MOD, 'I'], 'Italic'],
      [[MOD, 'K'], 'Insert link'],
      [[MOD, 'Shift', 'P'], 'Formatting command palette'],
    ],
  },
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="min-w-6 rounded border border-glass-border bg-white/5 px-1.5 py-0.5 text-center font-sans text-xs text-ink-secondary">
      {children}
    </kbd>
  );
}

/** Header button plus a global `?` key that opens the list of keyboard shortcuts. */
export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label="Keyboard shortcuts"
        aria-keyshortcuts="?"
        title="Keyboard shortcuts (?)"
        className="hidden sm:inline-flex items-center rounded-lg px-2 py-1.5 text-ink-secondary hover:bg-white/5 hover:text-ink"
      >
        <Kbd>?</Kbd>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClasses} />
        <Dialog.Content aria-describedby={undefined} className={`${dialogContentClasses} max-w-md`}>
          <Dialog.Title className={dialogTitleClasses}>Keyboard shortcuts</Dialog.Title>
          {SHORTCUTS.map(({ group, items }) => (
            <section key={group} className="mt-5">
              <h3 className="text-xs uppercase tracking-[0.1em] text-ink-muted">{group}</h3>
              <dl className="mt-2 space-y-2">
                {items.map(([keys, label]) => (
                  <div key={label} className="flex items-center justify-between gap-4 text-sm">
                    <dt className="text-ink-secondary">{label}</dt>
                    <dd className="flex gap-1">
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <Dialog.Close className="mt-6 w-full rounded-lg bg-white/5 border border-glass-border px-4 py-2 text-sm text-ink-secondary hover:bg-white/10 hover:text-ink">
            Close
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
