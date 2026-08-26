import type { MarkdownAuthoringCommand, MarkdownAuthoringCommandId } from './MarkdownAuthoringEditor';

type MarkdownAuthoringToolbarProps = {
  commands: readonly MarkdownAuthoringCommand[];
  onCommand: (command: MarkdownAuthoringCommandId) => void;
  onOpenPalette: (trigger?: HTMLButtonElement) => void;
  disabled?: boolean;
};

const compactCommandIds: MarkdownAuthoringCommandId[] = ['bold', 'italic', 'heading-1', 'bullet-list', 'task-list'];

export function MarkdownAuthoringToolbar({ commands, onCommand, onOpenPalette, disabled = false }: MarkdownAuthoringToolbarProps) {
  const compactCommands = commands.filter((command) => compactCommandIds.includes(command.id));
  const additionalCommands = commands.filter((command) => !compactCommandIds.includes(command.id));

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 px-2 py-1 dark:border-neutral-800" role="toolbar" aria-label="Formatting toolbar">
      {compactCommands.map((command) => (
        <button key={command.id} type="button" disabled={disabled} aria-label={command.label} title={command.label} onMouseDown={(event) => event.preventDefault()} onClick={() => onCommand(command.id)} className="rounded px-2 py-1 text-xs hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-neutral-800">
          {command.shortLabel}
        </button>
      ))}
      <div className="hidden items-center gap-1 sm:flex">
        {additionalCommands.map((command) => (
          <button key={command.id} type="button" disabled={disabled} aria-label={command.label} title={command.label} onMouseDown={(event) => event.preventDefault()} onClick={() => onCommand(command.id)} className="rounded px-2 py-1 text-xs hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-neutral-800">
            {command.shortLabel}
          </button>
        ))}
      </div>
      <button type="button" disabled={disabled} aria-label="More formatting commands" onMouseDown={(event) => event.preventDefault()} onClick={(event) => onOpenPalette(event.currentTarget)} className="rounded px-2 py-1 text-xs hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-neutral-800 sm:hidden">More</button>
      <button type="button" disabled={disabled} aria-label="Open formatting command palette" onMouseDown={(event) => event.preventDefault()} onClick={(event) => onOpenPalette(event.currentTarget)} className="hidden rounded px-2 py-1 text-xs hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-neutral-800 sm:inline-flex">Commands</button>
    </div>
  );
}
