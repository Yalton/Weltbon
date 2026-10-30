import { useEffect, useRef, useState, type RefObject } from 'react';
import type { MarkdownAuthoringCommand, MarkdownAuthoringCommandId } from './MarkdownAuthoringEditor';

type MarkdownCommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly MarkdownAuthoringCommand[];
  onCommand: (command: MarkdownAuthoringCommandId) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  onRestoreFocus?: () => void;
  disabled?: boolean;
};

export function MarkdownCommandPalette({ open, onOpenChange, commands, onCommand, returnFocusRef, onRestoreFocus, disabled = false }: MarkdownCommandPaletteProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      queueMicrotask(() => optionRefs.current[0]?.focus());
    }
  }, [open]);

  if (!open || disabled) return null;

  const close = () => {
    onOpenChange(false);
    queueMicrotask(() => {
      if (onRestoreFocus) onRestoreFocus();
      else returnFocusRef.current?.focus();
    });
  };
  const move = (direction: 1 | -1) => {
    const next = (activeIndex + direction + commands.length) % commands.length;
    setActiveIndex(next);
    optionRefs.current[next]?.focus();
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Formatting commands" className="fixed inset-x-0 bottom-0 z-50 rounded-t-lg border p-3 shadow-lg border-line-strong bg-canvas-lo text-ink sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[30rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    }}>
      <p className="mb-2 text-sm font-medium">Formatting commands</p>
      <div role="listbox" aria-label="Formatting commands">
        {commands.map((command, index) => (
          <button key={command.id} ref={(element) => { optionRefs.current[index] = element; }} type="button" disabled={disabled} role="option" aria-selected={activeIndex === index} tabIndex={activeIndex === index ? 0 : -1} onFocus={() => setActiveIndex(index)} onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
            else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onCommand(command.id); close(); }
          }} onClick={() => { onCommand(command.id); close(); }} className="block w-full rounded px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 hover:bg-white/5">
            <span>{command.label}</span>{command.shortcut && <span className="float-right text-ink-muted">{command.shortcut}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
