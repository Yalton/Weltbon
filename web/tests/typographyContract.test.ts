import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


// 5 audit surfaces. Static substring checks against component source.
const SRC = resolve(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

describe('typography contract', () => {
  it('EntryDetail.tsx applies the hero display heading + secondary-ink summary lede, NOT the contrast-bug pattern', () => {
    const src = read('views/EntryDetail.tsx');
    // Content-Forward Views §5: the page title moved out of the old form-style header and into
    // the hero, where it is set in the universe display serif. It keeps `tracking-tight` — the
    // repo's display headings take it too (see EmptyState.tsx, asserted below) — so the contract
    // still pins tracking-tight, now as part of the full display-heading string.
    expect(src).toContain('tracking-tight');
    expect(src).toContain('font-display text-3xl font-semibold tracking-tight text-ink');
    expect(src).toContain('text-lg leading-relaxed text-ink-secondary');
    // Anti-regression: raw neutral pairs (the source of the POL-04 contrast bug) must not return.
    expect(src).not.toMatch(/neutral-[0-9]/);
  });

  it('EntryList.tsx page heading uses tracking-tight', () => {
    const src = read('views/EntryList.tsx');
    expect(src).toContain('tracking-tight');
  });

  it('EmptyState.tsx applies tracking-tight to title + leading-[1.5] to body', () => {
    const src = read('components/EmptyState.tsx');
    expect(src).toContain('tracking-tight');
    expect(src).toContain('leading-[1.5]');
  });

  it('the entry list row uses §2.3 list-row sizing for title and meta', () => {
    // Content-Forward Views: the row's title moved into the shared EntryIdentity
    // component (medallion + serif title), which EntryCard and both timeline card
    // variants render — so the title's sizing now lives there, not in EntryCard.
    expect(read('components/EntryIdentity.tsx')).toContain('text-base leading-[1.5]');
    // The summary stays in EntryCard, its color migrated from raw neutral utilities
    // to the text-ink-secondary token.
    expect(read('components/EntryCard.tsx')).toContain('text-sm text-ink-secondary');
  });

  it('MarkdownRenderer.tsx wraps content in the prose typography plugin classes', () => {
    const src = read('components/MarkdownRenderer.tsx');
    expect(src).toContain('prose prose-neutral dark:prose-invert max-w-none');
  });
});
