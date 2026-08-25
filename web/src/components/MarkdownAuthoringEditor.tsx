import {
  codeBlockPlugin,
  diffSourcePlugin,
  headingsPlugin,
  imagePlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import './MarkdownAuthoringEditor.css';
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
  markdownShortcutPlugin(),
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
  const block = /:::[^\n]*(?:\n[\s\S]*?\n:::(?=\n|$)|[\s\S]*$)|^>\s*\[!([A-Za-z][A-Za-z0-9_-]*)\][^\n]*(?:\n>.*)*/gm;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = block.exec(markdown))) {
    if (match[1] && ['NOTE', 'TIP', 'WARNING'].includes(match[1].toUpperCase())) continue;
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

function markdownBlocks(markdown: string): Selection[] {
  const blocks: Selection[] = [];
  let start = 0;
  const separator = /\n{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = separator.exec(markdown))) {
    if (match.index > start) blocks.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  if (start < markdown.length) blocks.push({ start, end: markdown.length });
  return blocks;
}

function selectionBlock(editable: HTMLElement, node: Node): HTMLElement | null {
  let element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  while (element && element.parentElement !== editable) element = element.parentElement;
  return element;
}

function domTextOffset(block: HTMLElement, node: Node, offset: number): number | null {
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

type MarkdownTextMap = { text: string; positions: number[] };

function markdownTextMap(markdown: string): MarkdownTextMap {
  const positions: number[] = [];
  const text: string[] = [];

  const findToken = (start: number, end: number, token: string): number => {
    for (let index = start; index <= end - token.length; index += 1) {
      if (markdown[index] !== '\\' && markdown.slice(index, index + token.length) === token) return index;
    }
    return -1;
  };
  const findClosingBracket = (start: number, end: number): number => {
    let depth = 0;
    for (let index = start; index < end; index += 1) {
      if (markdown[index] === '\\') { index += 1; continue; }
      if (markdown[index] === '[') depth += 1;
      if (markdown[index] === ']') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  };
  const findClosingParen = (start: number, end: number): number => {
    let depth = 0;
    for (let index = start; index < end; index += 1) {
      if (markdown[index] === '\\') { index += 1; continue; }
      if (markdown[index] === '(') depth += 1;
      if (markdown[index] === ')') {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  };
  const append = (index: number) => {
    positions.push(index);
    text.push(markdown[index]);
  };
  const visit = (start: number, end: number) => {
    let index = start;
    let lineStart = true;
    while (index < end) {
      if (lineStart) {
        const prefix = markdown.slice(index, end).match(/^(?: {0,3}>\s?| {0,3}#{1,6}\s+| {0,3}- \[[ xX]\]\s+| {0,3}(?:[-*+]\s+|\d+\.\s+))/)?.[0];
        if (prefix) {
          index += prefix.length;
          lineStart = false;
          continue;
        }
      }
      if (markdown[index] === '\n') {
        append(index);
        lineStart = true;
        index += 1;
        continue;
      }
      lineStart = false;
      if (markdown[index] === '\\' && index + 1 < end) {
        append(index + 1);
        index += 2;
        continue;
      }
      if (markdown[index] === '!' && markdown[index + 1] === '[') {
        const labelEnd = findClosingBracket(index + 1, end);
        const destinationEnd = labelEnd !== -1 && markdown[labelEnd + 1] === '('
          ? findClosingParen(labelEnd + 1, end)
          : -1;
        if (destinationEnd !== -1) {
          index = destinationEnd + 1;
          continue;
        }
      }
      if (markdown[index] === '[') {
        const labelEnd = findClosingBracket(index, end);
        const destinationEnd = labelEnd !== -1 && markdown[labelEnd + 1] === '('
          ? findClosingParen(labelEnd + 1, end)
          : -1;
        if (destinationEnd !== -1) {
          visit(index + 1, labelEnd);
          index = destinationEnd + 1;
          continue;
        }
      }
      const marker = ['**', '__', '~~', '`', '*', '_'].find((candidate) => markdown.startsWith(candidate, index));
      if (marker) {
        const closing = findToken(index + marker.length, end, marker);
        if (closing !== -1) {
          visit(index + marker.length, closing);
          index = closing + marker.length;
          continue;
        }
      }
      append(index);
      index += 1;
    }
  };

  visit(0, markdown.length);
  return { text: text.join(''), positions };
}

function markdownOffsetForVisibleText(block: string, visibleOffset: number): number {
  const positions = markdownTextMap(block).positions;
  if (visibleOffset < positions.length) return positions[visibleOffset];
  return positions.at(-1) !== undefined ? positions.at(-1)! + 1 : block.length;
}

function markdownOffsetAfterVisibleText(block: string, visibleOffset: number): number {
  const positions = markdownTextMap(block).positions;
  if (visibleOffset === 0) return positions[0] ?? 0;
  return positions[visibleOffset - 1] !== undefined ? positions[visibleOffset - 1] + 1 : block.length;
}

function visibleOffsetForMarkdown(block: string, markdownOffset: number): number {
  const positions = markdownTextMap(block).positions;
  const index = positions.findIndex((position) => position >= markdownOffset);
  return index === -1 ? positions.length : index;
}

function renderedBlockText(block: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(block);
  return range.toString();
}

function domTextPoint(block: HTMLElement, offset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let remaining = offset;
  let last: Text | null = null;
  while (node) {
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    last = node;
    node = walker.nextNode() as Text | null;
  }
  return last ? { node: last, offset: last.data.length } : null;
}

function restoreLiveMarkdownSelection(editable: HTMLElement, markdown: string, selection: Selection): boolean {
  const blocks = markdownBlocks(markdown);
  const blockIndex = blocks.findIndex((block) => selection.start >= block.start && selection.end <= block.end);
  const markdownBlock = blocks[blockIndex];
  const domBlock = editable.children[blockIndex] as HTMLElement | undefined;
  if (!markdownBlock || !domBlock) return false;
  const source = markdown.slice(markdownBlock.start, markdownBlock.end);
  const start = domTextPoint(domBlock, visibleOffsetForMarkdown(source, selection.start - markdownBlock.start));
  const end = domTextPoint(domBlock, visibleOffsetForMarkdown(source, selection.end - markdownBlock.start));
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const domSelection = window.getSelection();
  domSelection?.removeAllRanges();
  domSelection?.addRange(range);
  return true;
}

function liveMarkdownSelection(editable: HTMLElement, markdown: string): Selection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editable.contains(range.startContainer) || !editable.contains(range.endContainer)) return null;
  const startBlock = selectionBlock(editable, range.startContainer);
  const endBlock = selectionBlock(editable, range.endContainer);
  if (!startBlock || startBlock !== endBlock) return null;
  const domBlocks = Array.from(editable.children);
  const blockIndex = domBlocks.indexOf(startBlock);
  const markdownBlock = markdownBlocks(markdown)[blockIndex];
  const start = domTextOffset(startBlock, range.startContainer, range.startOffset);
  const end = domTextOffset(endBlock, range.endContainer, range.endOffset);
  if (!markdownBlock || start === null || end === null) return null;
  const source = markdown.slice(markdownBlock.start, markdownBlock.end);
  if (markdownTextMap(source).text !== renderedBlockText(startBlock)) return null;
  const startOffset = markdownOffsetForVisibleText(source, start);
  return {
    start: markdownBlock.start + startOffset,
    end: markdownBlock.start + (range.collapsed ? startOffset : markdownOffsetAfterVisibleText(source, end)),
  };
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
  const paletteOriginRef = useRef<{
    mode: 'live' | 'source'; element: HTMLElement; range: Range | null;
    markdown?: string; selection?: Selection;
  } | null>(null);
  const activeRawBlockIndex = useRef<number | null>(null);
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

  const capturePaletteOrigin = (trigger?: HTMLElement) => {
    if (mode === 'source') {
      const source = sourceRef.current;
      if (source) {
        sourceSelection.current = { start: source.selectionStart, end: source.selectionEnd };
        paletteOriginRef.current = { mode: 'source', element: source, range: null };
        paletteReturnFocusRef.current = source;
        return;
      }
    }
    const editable = liveEditorWrappers.current[activeLiveEditorIndex.current]
      ?.querySelector<HTMLElement>('[contenteditable="true"]');
    const selection = window.getSelection();
    const range = selection?.rangeCount && editable?.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).cloneRange()
      : null;
    if (editable) {
      paletteOriginRef.current = { mode: 'live', element: editable, range };
      paletteReturnFocusRef.current = editable;
      return;
    }
    paletteReturnFocusRef.current = trigger ?? null;
  };

  const restorePaletteOrigin = () => {
    const origin = paletteOriginRef.current;
    if (!origin?.element.isConnected) {
      paletteReturnFocusRef.current?.focus();
      return;
    }
    origin.element.focus();
    if (origin.mode === 'source') {
      const source = origin.element as HTMLTextAreaElement;
      source.setSelectionRange(sourceSelection.current.start, sourceSelection.current.end);
      return;
    }
    if (origin.markdown && origin.selection && restoreLiveMarkdownSelection(origin.element, origin.markdown, origin.selection)) return;
    if (origin.range?.commonAncestorContainer.isConnected) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(origin.range);
    }
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

    if (rawFallback || activeRawBlockIndex.current !== null) return;
    const index = activeLiveEditorIndex.current;
    const editor = mdxEditorRefs.current[index];
    const editable = liveEditorWrappers.current[index]?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editor && editable) {
      const markdown = editor.getMarkdown();
      const selection = liveMarkdownSelection(editable, markdown);
      if (!selection) return;
      const transformed = transformMarkdownCommand(markdown, selection, command);
      const paletteOrigin = paletteOriginRef.current;
      if (paletteOrigin?.mode === 'live' && paletteOrigin.element === editable) {
        paletteOrigin.markdown = transformed.markdown;
        paletteOrigin.selection = transformed.selection;
        paletteOrigin.range = null;
      }
      window.getSelection()?.removeAllRanges();
      editor.setMarkdown(transformed.markdown);
      changeLivePart(index, transformed.markdown);
      return;
    }
  };

  useImperativeHandle(ref, () => ({ insertMarkdown, executeCommand }), [insertMarkdown, executeCommand]);

  let partOffset = 0;

  return (
    <section
      className="markdown-authoring-surface rounded-md border border-neutral-300 bg-white text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
      role="region"
      aria-label="Markdown authoring editor"
      onKeyDown={(event) => {
        if (disabled) return;
        if (!(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === 'p' && event.shiftKey) {
          event.preventDefault();
          capturePaletteOrigin(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
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
          capturePaletteOrigin(trigger);
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
            onFocus={() => { activeRawBlockIndex.current = 0; sourceSelection.current = { start: value.length, end: value.length }; }}
            onClick={() => { activeRawBlockIndex.current = 0; sourceSelection.current = { start: value.length, end: value.length }; }}
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
                  onFocus={() => { activeRawBlockIndex.current = index; sourceSelection.current = { start: start + part.content.length, end: start + part.content.length }; }}
                  onClick={() => { activeRawBlockIndex.current = index; sourceSelection.current = { start: start + part.content.length, end: start + part.content.length }; }}
                  className="m-3 overflow-x-auto rounded bg-neutral-100 p-3 text-sm dark:bg-neutral-900"
                  aria-label="Raw Markdown block"
                >
                  <code>{part.content}</code>
                </pre>
              ) : (
                <div
                  key={index}
                  ref={(element) => { liveEditorWrappers.current[index] = element; }}
                  onFocusCapture={() => { activeRawBlockIndex.current = null; activeLiveEditorIndex.current = index; }}
                  onClick={() => mdxEditorRefs.current[index]?.focus()}
                >
                  <MDXEditor
                    ref={(editor) => { mdxEditorRefs.current[index] = editor; }}
                    markdown={part.content}
                    plugins={editorPlugins}
                    className="markdown-authoring-editor-theme"
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
        onRestoreFocus={restorePaletteOrigin}
      />
    </section>
  );
});
