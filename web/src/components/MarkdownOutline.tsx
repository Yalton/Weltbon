import { extractMarkdownHeadings, type MarkdownHeading } from './MarkdownAuthoringEditor';

export { extractMarkdownHeadings };
export type { MarkdownHeading };

type MarkdownOutlineProps = {
  markdown: string;
  onNavigate: (heading: MarkdownHeading) => void;
};

export function MarkdownOutline({ markdown, onNavigate }: MarkdownOutlineProps) {
  const headings = extractMarkdownHeadings(markdown);

  return (
    <section aria-label="Markdown outline">
      <h2 className="text-sm font-semibold text-ink">Outline</h2>
      {headings.length === 0 ? (
        <p className="mt-2 text-sm text-ink-secondary">
          Add a heading to build the outline.
        </p>
      ) : (
        <ol className="mt-2 space-y-1">
          {headings.map((heading) => (
            <li key={`${heading.anchor}-${heading.start}`}>
              <button
                type="button"
                onClick={() => onNavigate(heading)}
                className="w-full rounded-md px-2 py-1 text-left text-sm text-[color:var(--color-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] hover:bg-white/5"
                style={{ paddingLeft: `${heading.depth * 0.75}rem` }}
              >
                {heading.text}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
