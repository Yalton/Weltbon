import {
  codeBlockPlugin,
  diffSourcePlugin,
  headingsPlugin,
  imagePlugin,
  linkPlugin,
  listsPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { MarkdownAuthoringToolbar } from './MarkdownAuthoringToolbar';
import { MarkdownCommandPalette } from './MarkdownCommandPalette';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

export type MarkdownAuthoringEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  universeId: string;
  entryId?: string;
  disabled?: boolean;
};

export type MarkdownAuthoringEditorHandle = {
  insertMarkdown: (markdown: string) => void;
  executeCommand: (command: MarkdownAuthoringCommandId) => void;
};

export type MarkdownAuthoringCommandId =
  | 'paragraph' | 'heading-1' | 'quote' | 'callout-note' | 'callout-tip' | 'callout-warning'
  | 'bullet-list' | 'ordered-list' | 'task-list' | 'code-block' | 'horizontal-rule'
  | 'bold' | 'italic' | 'strikethrough' | 'inline-code' | 'clear-formatting' | 'link';

export type MarkdownAuthoringCommand = {
  id: MarkdownAuthoringCommandId;
  label: string;
  shortLabel: string;
  markdown: string;
  shortcut?: string;
};

// The toolbar, palette, and keyboard shortcuts share this one registry.
// Callouts emit the documented `> [!TYPE]` syntax. Unlisted types remain raw.
export const markdownAuthoringCommands: readonly MarkdownAuthoringCommand[] = [
  { id: 'paragraph', label: 'Paragraph', shortLabel: '¶', markdown: 'Paragraph' },
  { id: 'heading-1', label: 'Heading 1', shortLabel: 'H1', markdown: '# Heading' },
  { id: 'quote', label: 'Quote', shortLabel: '❝', markdown: '> Quote' },
  { id: 'callout-note', label: 'Note callout', shortLabel: 'Note', markdown: '> [!NOTE]\n> Callout' },
  { id: 'callout-tip', label: 'Tip callout', shortLabel: 'Tip', markdown: '> [!TIP]\n> Callout' },
  { id: 'callout-warning', label: 'Warning callout', shortLabel: 'Warn', markdown: '> [!WARNING]\n> Callout' },
  { id: 'bullet-list', label: 'Bullet list', shortLabel: '•', markdown: '- Item' },
  { id: 'ordered-list', label: 'Ordered list', shortLabel: '1.', markdown: '1. Item' },
  { id: 'task-list', label: 'Task list', shortLabel: '☐', markdown: '- [ ] Task' },
  { id: 'code-block', label: 'Code block', shortLabel: '</>', markdown: '```\ncode\n```' },
  { id: 'horizontal-rule', label: 'Horizontal rule', shortLabel: '—', markdown: '---' },
  { id: 'bold', label: 'Bold', shortLabel: 'B', markdown: '**bold**', shortcut: 'Ctrl/Cmd-B' },
  { id: 'italic', label: 'Italic', shortLabel: 'I', markdown: '*italic*', shortcut: 'Ctrl/Cmd-I' },
  { id: 'strikethrough', label: 'Strikethrough', shortLabel: 'S', markdown: '~~strikethrough~~' },
  { id: 'inline-code', label: 'Inline code', shortLabel: '`', markdown: '`code`' },
  { id: 'clear-formatting', label: 'Clear formatting', shortLabel: 'Clear', markdown: 'Plain text' },
  { id: 'link', label: 'Link', shortLabel: 'Link', markdown: '[link text](https://)', shortcut: 'Ctrl/Cmd-K' },
];

type Selection = { start: number; end: number };
type MarkdownPart = { kind: 'markdown' | 'raw'; content: string };

const editorPlugins = [
  headingsPlugin(),
  listsPlugin(),
  quotePlugin(),
  codeBlockPlugin(),
  thematicBreakPlugin(),
  tablePlugin(),
  linkPlugin(),
  imagePlugin(),
  // Keep source support inside the editor boundary. The shell owns the labelled
  // toggle so it can preserve an exact raw document when the live parser cannot.
  diffSourcePlugin({ viewMode: 'rich-text' }),
];
function splitUnsupportedBlocks(markdown: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  const block = /:::[^\n]*(?:\n[\s\S]*?\n:::(?=\n|$)|[\s\S]*$)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = block.exec(markdown))) {
    if (match.index > cursor) parts.push({ kind: 'markdown', content: markdown.slice(cursor, match.index) });
    parts.push({ kind: 'raw', content: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < markdown.length || parts.length === 0) parts.push({ kind: 'markdown', content: markdown.slice(cursor) });
  return parts;
}

function insertBlockMarkdown(markdown: string, selection: Selection, block: string): { markdown: string; selection: Selection } {
  const before = markdown.slice(0, selection.start);
  const after = markdown.slice(selection.end);
  const prefix = before.length > 0 && !before.endsWith('\n\n') ? '\n\n' : '';
  const suffix = after.length > 0 && !after.startsWith('\n\n') ? '\n\n' : '';
  const inserted = `${prefix}${block}${suffix}`;
  const cursor = before.length + prefix.length + block.length;
  return {
    markdown: `${before}${inserted}${after}`,
    selection: { start: cursor, end: cursor },
  };
}

function replaceMarkdownSelection(markdown: string, selection: Selection, replacement: string): { markdown: string; selection: Selection } {
  const before = markdown.slice(0, selection.start);
  const after = markdown.slice(selection.end);
  const cursor = before.length + replacement.length;
  return { markdown: `${before}${replacement}${after}`, selection: { start: cursor, end: cursor } };
}

function inlineCommandMarkdown(command: MarkdownAuthoringCommand, selected: string): string | null {
  const text = selected || command.markdown.replace(/^([*_~`]+)|([*_~`]+)$/g, '');
  switch (command.id) {
    case 'bold': return `**${text}**`;
    case 'italic': return `*${text}*`;
    case 'strikethrough': return `~~${text}~~`;
    case 'inline-code': return `\`${text}\``;
    case 'link': return `[${selected || 'link text'}](https://)`;
    case 'clear-formatting': return selected.replace(/^(\*\*|__|~~|`|\*|_)([\s\S]*?)\1$/, '$2') || command.markdown;
    default: return null;
  }
}

function currentLineSelection(markdown: string, selection: Selection): Selection {
  const start = markdown.lastIndexOf('\n', Math.max(0, selection.start - 1)) + 1;
  const newline = markdown.indexOf('\n', selection.end);
  return { start, end: newline === -1 ? markdown.length : newline };
}

function plainBlockText(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^- \[[ xX]\]\s+/, '')
    .replace(/^(?:[-*+]\s+|\d+\.\s+)/, '')
    .replace(/^(\*\*|__|~~|`)([\s\S]*?)\1$/, '$2');
}

function blockCommandMarkdown(command: MarkdownAuthoringCommand, line: string): string {
  const text = plainBlockText(line) || command.markdown;
  switch (command.id) {
    case 'paragraph': return plainBlockText(line) || command.markdown;
    case 'heading-1': return `# ${plainBlockText(line) || 'Heading'}`;
    case 'quote': return `> ${plainBlockText(line) || 'Quote'}`;
    case 'callout-note': return `> [!NOTE]\n> ${plainBlockText(line) || 'Callout'}`;
    case 'callout-tip': return `> [!TIP]\n> ${plainBlockText(line) || 'Callout'}`;
    case 'callout-warning': return `> [!WARNING]\n> ${plainBlockText(line) || 'Callout'}`;
    case 'bullet-list': return `- ${plainBlockText(line) || 'Item'}`;
    case 'ordered-list': return `1. ${plainBlockText(line) || 'Item'}`;
    case 'task-list': return `- [ ] ${plainBlockText(line) || 'Task'}`;
    case 'code-block': return `\`\`\`\n${plainBlockText(line) || 'code'}\n\`\`\``;
    case 'horizontal-rule': return '---';
    default: return text;
  }
}

function transformMarkdownCommand(markdown: string, selection: Selection, command: MarkdownAuthoringCommand): { markdown: string; selection: Selection } {
  const selected = markdown.slice(selection.start, selection.end);
  if (command.id === 'clear-formatting') {
    const lineSelection = currentLineSelection(markdown, selection);
    return replaceMarkdownSelection(markdown, lineSelection, plainBlockText(markdown.slice(lineSelection.start, lineSelection.end)) || command.markdown);
  }
  const inline = inlineCommandMarkdown(command, selected);
  if (inline !== null) return replaceMarkdownSelection(markdown, selection, inline);
  const lineSelection = currentLineSelection(markdown, selection);
  return replaceMarkdownSelection(markdown, lineSelection, blockCommandMarkdown(command, markdown.slice(lineSelection.start, lineSelection.end)));
}

export const MarkdownAuthoringEditor = forwardRef<
  MarkdownAuthoringEditorHandle,
  MarkdownAuthoringEditorProps
>(function MarkdownAuthoringEditor({ value, onChange, disabled = false }, ref) {
  const [mode, setMode] = useState<'live' | 'source'>('live');
  const [liveParserError, setLiveParserError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const mdxEditorRefs = useRef<Array<MDXEditorMethods | null>>([]);
  const liveEditorWrappers = useRef<Array<HTMLDivElement | null>>([]);
  const activeLiveEditorIndex = useRef(0);
  const restoreLiveFocus = useRef(false);
  const liveSelectionRange = useRef<Range | null>(null);
  const liveEditorContainerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const paletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const latestMarkdown = useRef(value);
  const sourceSelection = useRef<Selection>({ start: 0, end: 0 });
  const parts = splitUnsupportedBlocks(value);
  const rawFallback = liveParserError !== null;

  useEffect(() => {
    if (value === latestMarkdown.current) return;
    latestMarkdown.current = value;
    setLiveParserError(null);
    parts.forEach((part, index) => {
      if (part.kind === 'markdown') mdxEditorRefs.current[index]?.setMarkdown(part.content);
    });
  }, [value, parts]);

  useEffect(() => {
    if (mode === 'source') {
      const source = sourceRef.current;
      if (!source) return;
      source.focus();
      source.setSelectionRange(sourceSelection.current.start, sourceSelection.current.end);
      return;
    }
    if (restoreLiveFocus.current) {
      mdxEditorRefs.current[activeLiveEditorIndex.current]?.focus();
      liveEditorWrappers.current[activeLiveEditorIndex.current]
        ?.querySelector<HTMLElement>('[contenteditable="true"]')
        ?.focus();
      const range = liveSelectionRange.current;
      if (range?.commonAncestorContainer.isConnected) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      restoreLiveFocus.current = false;
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'live' || rawFallback) return;
    const labelEditable = () => {
      liveEditorContainerRef.current
        ?.querySelector<HTMLElement>('[contenteditable="true"]')
        ?.setAttribute('aria-label', 'Entry body');
    };
    labelEditable();
    const observer = new MutationObserver(labelEditable);
    const container = liveEditorContainerRef.current;
    if (container) observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [mode, rawFallback, value]);

  const changeLivePart = (index: number, markdown: string) => {
    const next = parts.map((part, partIndex) => partIndex === index ? { ...part, content: markdown } : part)
      .map((part) => part.content)
      .join('');
    latestMarkdown.current = next;
    onChange(next);
  };

  const switchMode = (nextMode: 'live' | 'source') => {
    if (nextMode === 'source') {
      const activeElement = liveEditorWrappers.current[activeLiveEditorIndex.current]
        ?.querySelector<HTMLElement>('[contenteditable="true"]');
      restoreLiveFocus.current = activeElement === document.activeElement;
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      liveSelectionRange.current = range && liveEditorContainerRef.current?.contains(range.commonAncestorContainer)
        ? range.cloneRange()
        : null;
    } else {
      restoreLiveFocus.current = true;
    }
    setMode(nextMode);
  };

  const insertMarkdown = (markdown: string) => {
    if (disabled) return;
    if (mode === 'source') {
      const inserted = insertBlockMarkdown(latestMarkdown.current, sourceSelection.current, markdown);
      sourceSelection.current = inserted.selection;
      latestMarkdown.current = inserted.markdown;
      onChange(inserted.markdown);
      return;
    }

    const editor = mdxEditorRefs.current[activeLiveEditorIndex.current];
    if (editor && !rawFallback) {
      editor.insertMarkdown(`\n\n${markdown}\n\n`);
      return;
    }

    const inserted = insertBlockMarkdown(latestMarkdown.current, sourceSelection.current, markdown);
    sourceSelection.current = inserted.selection;
    latestMarkdown.current = inserted.markdown;
    onChange(inserted.markdown);
  };

  const executeCommand = (commandId: MarkdownAuthoringCommandId) => {
    if (disabled) return;
    const command = markdownAuthoringCommands.find(({ id }) => id === commandId);
    if (!command) return;
    if (mode === 'source') {
      const transformed = transformMarkdownCommand(latestMarkdown.current, sourceSelection.current, command);
      sourceSelection.current = transformed.selection;
      latestMarkdown.current = transformed.markdown;
      onChange(transformed.markdown);
      return;
    }

    const index = activeLiveEditorIndex.current;
    const editor = mdxEditorRefs.current[index];
    if (editor && !rawFallback) {
      const markdown = editor.getMarkdown();
      const selected = editor.getSelectionMarkdown() || window.getSelection()?.toString() || '';
      const start = selected ? markdown.indexOf(selected) : 0;
      const transformed = transformMarkdownCommand(markdown, {
        start: start < 0 ? 0 : start,
        end: start < 0 ? 0 : start + selected.length,
      }, command);
      window.getSelection()?.removeAllRanges();
      editor.setMarkdown(transformed.markdown);
      changeLivePart(index, transformed.markdown);
      return;
    }
    insertMarkdown(command.markdown);
  };

  useImperativeHandle(ref, () => ({ insertMarkdown, executeCommand }), [mode, onChange, rawFallback]);

  let partOffset = 0;

  return (
    <section
      className="rounded-md border border-neutral-300 dark:border-neutral-700"
      role="region"
      aria-label="Markdown authoring editor"
      onKeyDown={(event) => {
        if (disabled) return;
        if (!(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === 'p' && event.shiftKey) {
          event.preventDefault();
          paletteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setPaletteOpen(true);
          return;
        }
        const command = key === 'b' ? 'bold'
          : key === 'i' ? 'italic'
            : key === 'k' ? 'link'
              : undefined;
        if (command) {
          event.preventDefault();
          executeCommand(command);
        }
      }}
    >
      <MarkdownAuthoringToolbar
        commands={markdownAuthoringCommands}
        disabled={disabled}
        onCommand={executeCommand}
        onOpenPalette={(trigger) => {
          if (disabled) return;
          if (trigger) paletteReturnFocusRef.current = trigger;
          setPaletteOpen(true);
        }}
      />
      <div className="flex items-center justify-end gap-1 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800" role="group" aria-label="Editor mode">
        <button
          type="button"
          aria-pressed={mode === 'live'}
          onClick={() => switchMode('live')}
          className="rounded px-2 py-1 text-xs data-[state=active]:bg-neutral-100 dark:data-[state=active]:bg-neutral-800"
          data-state={mode === 'live' ? 'active' : 'inactive'}
        >
          Live Preview
        </button>
        <button
          type="button"
          aria-pressed={mode === 'source'}
          onClick={() => switchMode('source')}
          className="rounded px-2 py-1 text-xs data-[state=active]:bg-neutral-100 dark:data-[state=active]:bg-neutral-800"
          data-state={mode === 'source' ? 'active' : 'inactive'}
        >
          Source
        </button>
      </div>

      <div hidden={mode !== 'live'} aria-hidden={mode !== 'live'}>
        {rawFallback ? (
          <pre
            tabIndex={0}
            onFocus={() => { sourceSelection.current = { start: value.length, end: value.length }; }}
            onClick={() => { sourceSelection.current = { start: value.length, end: value.length }; }}
            className="m-3 overflow-x-auto rounded bg-neutral-100 p-3 text-sm dark:bg-neutral-900"
            aria-label="Raw Markdown block"
          >
            <code>{value}</code>
          </pre>
        ) : (
          <div ref={liveEditorContainerRef}>
            {parts.map((part, index) => {
              const start = partOffset;
              partOffset += part.content.length;
              return part.kind === 'raw' ? (
                <pre
                  key={`${index}-${part.content}`}
                  tabIndex={0}
                  onFocus={() => { sourceSelection.current = { start: start + part.content.length, end: start + part.content.length }; }}
                  onClick={() => { sourceSelection.current = { start: start + part.content.length, end: start + part.content.length }; }}
                  className="m-3 overflow-x-auto rounded bg-neutral-100 p-3 text-sm dark:bg-neutral-900"
                  aria-label="Raw Markdown block"
                >
                  <code>{part.content}</code>
                </pre>
              ) : (
                <div
                  key={index}
                  ref={(element) => { liveEditorWrappers.current[index] = element; }}
                  onFocusCapture={() => { activeLiveEditorIndex.current = index; }}
                  onClick={() => mdxEditorRefs.current[index]?.focus()}
                >
                  <MDXEditor
                    ref={(editor) => { mdxEditorRefs.current[index] = editor; }}
                    markdown={part.content}
                    plugins={editorPlugins}
                    readOnly={disabled}
                    placeholder="Write in Markdown..."
                    contentEditableClassName="prose prose-neutral dark:prose-invert max-w-none min-h-48 px-3 py-2 focus:outline-none"
                    onChange={(markdown, initialMarkdownNormalize) => {
                      if (!initialMarkdownNormalize) changeLivePart(index, markdown);
                    }}
                    onError={({ error }) => setLiveParserError(error)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {mode === 'source' && (
        <textarea
          ref={sourceRef}
          aria-label="Entry body"
          rows={12}
          value={value}
          disabled={disabled}
          onSelect={(event) => {
            sourceSelection.current = {
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            };
          }}
          onChange={(event) => {
            latestMarkdown.current = event.target.value;
            setLiveParserError(null);
            sourceSelection.current = {
              start: event.target.selectionStart,
              end: event.target.selectionEnd,
            };
            onChange(event.target.value);
          }}
          className="w-full resize-y bg-transparent px-3 py-2 font-mono text-sm focus:outline-none"
        />
      )}
      <MarkdownCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={markdownAuthoringCommands}
        disabled={disabled}
        onCommand={executeCommand}
        returnFocusRef={paletteReturnFocusRef}
      />
    </section>
  );
});
