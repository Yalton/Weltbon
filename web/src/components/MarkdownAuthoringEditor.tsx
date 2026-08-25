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

function usesUnsupportedSyntax(markdown: string): boolean {
  return (
    /(^|\n)\s*:::[^\n]*/.test(markdown) ||
    /!?\[\[[\s\S]*?(?:\]\]|$)/.test(markdown) ||
    /asset:\/\//.test(markdown)
  );
}

export const MarkdownAuthoringEditor = forwardRef<
  MarkdownAuthoringEditorHandle,
  MarkdownAuthoringEditorProps
>(function MarkdownAuthoringEditor({ value, onChange, disabled = false }, ref) {
  const [mode, setMode] = useState<'live' | 'source'>('live');
  const [liveParserError, setLiveParserError] = useState<string | null>(null);
  const mdxEditorRef = useRef<MDXEditorMethods>(null);
  const liveEditorContainerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const latestMarkdown = useRef(value);
  const sourceSelection = useRef<Selection>({ start: 0, end: 0 });
  const rawFallback = usesUnsupportedSyntax(value) || liveParserError !== null;

  useEffect(() => {
    if (value === latestMarkdown.current) return;
    latestMarkdown.current = value;
    setLiveParserError(null);
    mdxEditorRef.current?.setMarkdown(value);
  }, [value]);

  useEffect(() => {
    if (mode !== 'source') return;
    const source = sourceRef.current;
    if (!source) return;
    source.focus();
    source.setSelectionRange(sourceSelection.current.start, sourceSelection.current.end);
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

  useImperativeHandle(ref, () => ({
    insertMarkdown(markdown: string) {
      if (mode === 'source') {
        const { start, end } = sourceSelection.current;
        const next =
          latestMarkdown.current.slice(0, start) +
          markdown +
          latestMarkdown.current.slice(end);
        const cursor = start + markdown.length;
        sourceSelection.current = { start: cursor, end: cursor };
        latestMarkdown.current = next;
        onChange(next);
        return;
      }

      if (mdxEditorRef.current && !usesUnsupportedSyntax(latestMarkdown.current)) {
        mdxEditorRef.current.insertMarkdown(markdown);
        return;
      }

      const next = `${latestMarkdown.current}${markdown}`;
      latestMarkdown.current = next;
      onChange(next);
    },
  }), [mode, onChange]);

  return (
    <section className="rounded-md border border-neutral-300 dark:border-neutral-700">
      <div className="flex items-center justify-end gap-1 border-b border-neutral-200 px-2 py-1 dark:border-neutral-800" role="group" aria-label="Editor mode">
        <button
          type="button"
          aria-pressed={mode === 'live'}
          onClick={() => setMode('live')}
          className="rounded px-2 py-1 text-xs data-[state=active]:bg-neutral-100 dark:data-[state=active]:bg-neutral-800"
          data-state={mode === 'live' ? 'active' : 'inactive'}
        >
          Live Preview
        </button>
        <button
          type="button"
          aria-pressed={mode === 'source'}
          onClick={() => setMode('source')}
          className="rounded px-2 py-1 text-xs data-[state=active]:bg-neutral-100 dark:data-[state=active]:bg-neutral-800"
          data-state={mode === 'source' ? 'active' : 'inactive'}
        >
          Source
        </button>
      </div>

      {mode === 'source' ? (
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
      ) : rawFallback ? (
        <pre className="m-3 overflow-x-auto rounded bg-neutral-100 p-3 text-sm dark:bg-neutral-900" aria-label="Raw Markdown block">
          <code>{value}</code>
        </pre>
      ) : (
        <div ref={liveEditorContainerRef} onClick={() => mdxEditorRef.current?.focus()}>
          <MDXEditor
            ref={mdxEditorRef}
            markdown={value}
            plugins={editorPlugins}
            readOnly={disabled}
            placeholder="Write in Markdown..."
            contentEditableClassName="prose prose-neutral dark:prose-invert max-w-none min-h-48 px-3 py-2 focus:outline-none"
            onChange={(markdown, initialMarkdownNormalize) => {
              if (initialMarkdownNormalize) return;
              latestMarkdown.current = markdown;
              onChange(markdown);
            }}
            onError={({ error }) => setLiveParserError(error)}
          />
        </div>
      )}
    </section>
  );
});
