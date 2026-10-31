import { parseMarkdownFrontmatter, replaceSupportedFrontmatterTags } from '../lib/markdownAuthoring';
import { TagInput } from './TagInput';
import { useEffect, useRef } from 'react';

export type MarkdownFrontmatterPanelProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  onEditInSource?: () => void;
  disabled?: boolean;
};

export function MarkdownFrontmatterPanel({
  markdown,
  onChange,
  onEditInSource,
  disabled = false,
}: MarkdownFrontmatterPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const parsed = parseMarkdownFrontmatter(markdown);
  const editable = !disabled && parsed.diagnostics.length === 0;

  useEffect(() => {
    const input = panelRef.current?.querySelector<HTMLInputElement>('input[placeholder="Add a tag..."]');
    input?.setAttribute('role', 'searchbox');
    input?.setAttribute('aria-label', 'Document tag input');
  });

  const updateTags = (tags: string[]) => {
    if (!editable) return;
    const updated = replaceSupportedFrontmatterTags(markdown, tags);
    if (updated !== markdown) onChange(updated);
  };

  return (
    <section
      ref={panelRef}
      className="border-b px-3 py-2 border-line"
      role="region"
      aria-labelledby="document-tags-heading"
      aria-disabled={disabled || undefined}
    >
      <h2 id="document-tags-heading" className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        Document tags
      </h2>
      {parsed.diagnostics.length > 0 && (
        <div role="alert" className="mb-2 text-sm text-amber-300">
          <p>{parsed.diagnostics[0].message}</p>
          {onEditInSource && (
            <button
              type="button"
              className="mt-1 rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
              onClick={onEditInSource}
            >
              Edit in Source
            </button>
          )}
        </div>
      )}
      <fieldset disabled={!editable} className="min-w-0 border-0 p-0">
        <TagInput value={parsed.tags} onChange={updateTags} />
      </fieldset>
    </section>
  );
}
