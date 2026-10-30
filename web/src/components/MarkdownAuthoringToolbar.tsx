import type { MarkdownAuthoringCommand, MarkdownAuthoringCommandId } from './MarkdownAuthoringEditor';

type MarkdownAuthoringToolbarProps = {
  commands: readonly MarkdownAuthoringCommand[];
  onCommand: (command: MarkdownAuthoringCommandId) => void;
  onOpenPalette: (trigger?: HTMLButtonElement) => void;
  onLink?: () => void;
  disabled?: boolean;
};

// 'Ctrl/Cmd-B' -> 'Control+B Meta+B' (the aria-keyshortcuts syntax).
function keyShortcuts(shortcut: string | undefined): string | undefined {
  if (!shortcut) return undefined;
  const key = shortcut.replace('Ctrl/Cmd-', '');
  return `Control+${key} Meta+${key}`;
}

function commandTitle(command: MarkdownAuthoringCommand): string {
  return command.shortcut ? `${command.label} (${command.shortcut})` : command.label;
}

const compactCommandIds: MarkdownAuthoringCommandId[] = ['bold', 'italic', 'heading-1', 'bullet-list', 'task-list'];

export function MarkdownAuthoringToolbar({ commands, onCommand, onOpenPalette, onLink, disabled = false }: MarkdownAuthoringToolbarProps) {
  const compactCommands = commands.filter((command) => compactCommandIds.includes(command.id));
  const additionalCommands = commands.filter((command) => !compactCommandIds.includes(command.id));

  return (
    <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1 border-line" role="toolbar" aria-label="Formatting toolbar">
      {compactCommands.map((command) => (
        <button key={command.id} type="button" disabled={disabled} aria-label={command.label} title={commandTitle(command)} aria-keyshortcuts={keyShortcuts(command.shortcut)} onMouseDown={(event) => event.preventDefault()} onClick={() => command.id === 'link' && onLink ? onLink() : onCommand(command.id)} className="rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 hover:bg-white/5">
          {command.shortLabel}
        </button>
      ))}
      <div className="hidden items-center gap-1 sm:flex">
        {additionalCommands.map((command) => (
          <button key={command.id} type="button" disabled={disabled} aria-label={command.label} title={commandTitle(command)} aria-keyshortcuts={keyShortcuts(command.shortcut)} onMouseDown={(event) => event.preventDefault()} onClick={() => command.id === 'link' && onLink ? onLink() : onCommand(command.id)} className="rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 hover:bg-white/5">
            {command.shortLabel}
          </button>
        ))}
      </div>
      <button type="button" disabled={disabled} aria-label="More formatting commands" onMouseDown={(event) => event.preventDefault()} onClick={(event) => onOpenPalette(event.currentTarget)} className="rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 hover:bg-white/5 sm:hidden">More</button>
      <button type="button" disabled={disabled} aria-label="Open formatting command palette" title="Command palette (Ctrl/Cmd-Shift-P)" aria-keyshortcuts="Control+Shift+P Meta+Shift+P" onMouseDown={(event) => event.preventDefault()} onClick={(event) => onOpenPalette(event.currentTarget)} className="hidden rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 hover:bg-white/5 sm:inline-flex">Commands</button>
    </div>
  );
}
