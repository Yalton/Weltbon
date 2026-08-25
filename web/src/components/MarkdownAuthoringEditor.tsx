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
};

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
  const block = /:::[^\n]*(?:\n[\s\S]*?\n:::)(?=\n|$)/g;
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

export const MarkdownAuthoringEditor = forwardRef<
  MarkdownAuthoringEditorHandle,
  MarkdownAuthoringEditorProps
>(function MarkdownAuthoringEditor({ value, onChange, disabled = false }, ref) {
  const [mode, setMode] = useState<'live' | 'source'>('live');
  const [liveParserError, setLiveParserError] = useState<string | null>(null);
  const mdxEditorRefs = useRef<Array<MDXEditorMethods | null>>([]);
  const activeLiveEditorIndex = useRef(0);
  const restoreLiveFocus = useRef(false);
  const liveSelectionRange = useRef<Range | null>(null);
  const liveEditorContainerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
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
      liveEditorContainerRef.current
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
      const activeElement = liveEditorContainerRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
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

  useImperativeHandle(ref, () => ({
    insertMarkdown(markdown: string) {
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
    },
  }), [mode, onChange, rawFallback]);

  return (
    <section className="rounded-md border border-neutral-300 dark:border-neutral-700">
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
          <pre className="m-3 overflow-x-auto rounded bg-neutral-100 p-3 text-sm dark:bg-neutral-900" aria-label="Raw Markdown block">
            <code>{value}</code>
          </pre>
        ) : (
          <div ref={liveEditorContainerRef}>
            {parts.map((part, index) => part.kind === 'raw' ? (
              <pre key={`${index}-${part.content}`} className="m-3 overflow-x-auto rounded bg-neutral-100 p-3 text-sm dark:bg-neutral-900" aria-label="Raw Markdown block">
                <code>{part.content}</code>
              </pre>
            ) : (
              <div
                key={index}
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
            ))}
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
    </section>
  );
});
