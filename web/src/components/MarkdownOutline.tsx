import { splitUnsupportedBlocks } from './MarkdownAuthoringEditor';

export type MarkdownHeading = {
  anchor: string;
  depth: number;
  start: number;
  end: number;
  text: string;
};

function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function headingText(raw: string): string {
  return raw.trim().replace(/[ \t]+#+[ \t]*$/, '').trim();
}

function collectPartHeadings(markdown: string, offset: number): Omit<MarkdownHeading, 'anchor'>[] {
  const headings: Omit<MarkdownHeading, 'anchor'>[] = [];
  const lines = markdown.split('\n');
  const starts: number[] = [];
  let cursor = 0;
  let fence: { marker: string; length: number } | null = null;

  lines.forEach((line) => {
    starts.push(cursor);
    cursor += line.length + 1;
  });

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const content = line.trimStart();

    if (fence) {
      if (new RegExp(`^${fence.marker}{${fence.length},}[ \\t]*$`).test(content)) fence = null;
      continue;
    }

    const openingFence = content.match(/^(`{3,}|~{3,})(.*)$/);
    if (openingFence && !(openingFence[1][0] === '`' && openingFence[2].includes('`'))) {
      fence = { marker: openingFence[1][0], length: openingFence[1].length };
      continue;
    }

    const atxMatch = content.match(/^(#{1,6})[ \t]+(.+?)$/);
    if (atxMatch) {
      const text = headingText(atxMatch[2]);
      if (text.length > 0) {
        headings.push({
          depth: atxMatch[1].length,
          start: offset + starts[index],
          end: offset + starts[index] + line.length,
          text,
        });
      }
      continue;
    }

    const underline = lines[index + 1]?.trim();
    if (
      line.trim().length > 0 &&
      !/^ {4,}/.test(line) &&
      !/^ {0,3}(?:>|[-*+][ \t]|\d+[.)][ \t])/.test(line) &&
      underline &&
      /^ {0,3}(=+|-+)[ \t]*$/.test(lines[index + 1])
    ) {
      headings.push({
        depth: underline.startsWith('=') ? 1 : 2,
        start: offset + starts[index],
        end: offset + starts[index + 1] + lines[index + 1].length,
        text: line.trim(),
      });
      index += 1;
    }
  }

  return headings;
}

export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: Omit<MarkdownHeading, 'anchor'>[] = [];
  let offset = 0;

  splitUnsupportedBlocks(markdown).forEach((part) => {
    if (part.kind === 'markdown') headings.push(...collectPartHeadings(part.content, offset));
    offset += part.content.length;
  });

  const collisions = new Map<string, number>();
  return headings.map((heading) => {
    const base = slugifyHeading(heading.text);
    const count = (collisions.get(base) ?? 0) + 1;
    collisions.set(base, count);
    return {
      ...heading,
      anchor: count === 1 ? base : `${base}-${count}`,
    };
  });
}

type MarkdownOutlineProps = {
  markdown: string;
  onNavigate: (heading: MarkdownHeading) => void;
};

export function MarkdownOutline({ markdown, onNavigate }: MarkdownOutlineProps) {
  const headings = extractMarkdownHeadings(markdown);

  return (
    <section aria-label="Markdown outline">
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Outline</h2>
      {headings.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          Add a heading to build the outline.
        </p>
      ) : (
        <ol className="mt-2 space-y-1">
          {headings.map((heading) => (
            <li key={`${heading.anchor}-${heading.start}`}>
              <button
                type="button"
                onClick={() => onNavigate(heading)}
                className="w-full rounded-md px-2 py-1 text-left text-sm text-[color:var(--color-accent)] hover:bg-neutral-100 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] dark:hover:bg-neutral-800"
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
