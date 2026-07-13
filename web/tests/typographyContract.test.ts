import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// POL-04 Task 2 — typography classes from UI-SPEC §2.3 must appear on the
// 5 audit surfaces. Static substring checks against component source.
const SRC = resolve(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

describe('typography contract (POL-04 Task 2)', () => {
  it('EntryDetail.tsx applies tracking-tight + neutral-700/300 body color, NOT the contrast-bug pattern', () => {
    const src = read('views/EntryDetail.tsx');
    expect(src).toContain('tracking-tight');
    expect(src).toContain('text-neutral-700 dark:text-neutral-300');
    // Anti-regression: the light-mode contrast bug from POL-04 fix #3 must not return.
    expect(src).not.toContain('text-neutral-300 dark:text-neutral-300');
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

  it('EntryCard.tsx uses §2.3 list-row sizing for title and meta', () => {
    const src = read('components/EntryCard.tsx');
    expect(src).toContain('text-base leading-[1.5]');
    // Content-Forward Views: summary color migrated from raw neutral utilities
    // to the text-ink-secondary token (see Task 7 — border/text tokenization).
    expect(src).toContain('text-sm text-ink-secondary');
  });

  it('MarkdownRenderer.tsx wraps content in the prose typography plugin classes', () => {
    const src = read('components/MarkdownRenderer.tsx');
    expect(src).toContain('prose prose-neutral dark:prose-invert max-w-none');
  });
});
