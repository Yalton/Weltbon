
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { WikilinkResolutionData } from './WikilinkText';

// useEntry mock — supplies the embedded entry body for the resolved path
// without a real network/react-query fetch.
const mockUseEntry = vi.fn();
vi.mock('../hooks/useEntries', async () => {
  const actual =
    await vi.importActual<typeof import('../hooks/useEntries')>('../hooks/useEntries');
  return { ...actual, useEntry: (...args: unknown[]) => mockUseEntry(...args) };
});

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // No ShareModeProvider → authenticated mode (the safe default), so EntryEmbed
  // builds /universes/:uid/entries/:id targets.
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function makeWikis(overrides: Partial<WikilinkResolutionData> = {}): WikilinkResolutionData {
  return {
    entryTitles: new Map([['empire', 'e-empire']]),
    dictionaryWords: new Map(),
    universeId: 'u1',
    languageEntryId: null,
    // Host entry differs from the embed target so the D-06 self-guard does not
    // fire — this exercises the genuine resolved-callout path.
    currentEntryId: 'e-host',
    ...overrides,
  };
}

describe('CR-01: resolved ![[entry]] embed renders without invalid <p> nesting', () => {
  beforeEach(() => {
    mockUseEntry.mockReturnValue({
      data: {
        id: 'e-empire',
        title: 'Empire',
        icon: '🏰',
        body: 'The Empire body text.',
        assetUrls: {},
      },
      isLoading: false,
      isError: false,
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('does not place the embed callout inside a <p> element (standalone embed)', () => {
    const { container } = render(
      <Wrapper>
        <MarkdownRenderer content="![[Empire]]" wikis={makeWikis()} />
      </Wrapper>,
    );

    const callout = screen.getByTestId('embed-callout');
    expect(callout).toBeInTheDocument();
    // The bug: components.p wrapped the block callout in <p>. After the fix the
    // standalone-embed paragraph renders a <div> wrapper instead.
    expect(callout.closest('p')).toBeNull();
    // No <p> may be nested inside another <p> anywhere in the rendered tree
    // (the embedded body's own <p> must not sit inside an outer <p>).
    expect(container.querySelector('p p')).toBeNull();
  });

  it('does not place the embed callout inside a <p> element (text + embed)', () => {
    const { container } = render(
      <Wrapper>
        <MarkdownRenderer content="See ![[Empire]] now." wikis={makeWikis()} />
      </Wrapper>,
    );

    expect(screen.getByTestId('embed-callout').closest('p')).toBeNull();
    expect(container.querySelector('p p')).toBeNull();
  });

  it('still wraps an ordinary paragraph (no embed) in a <p>', () => {
    const { container } = render(
      <Wrapper>
        <MarkdownRenderer content="Just some prose." wikis={makeWikis()} />
      </Wrapper>,
    );

    // Regression guard: the <div>-instead-of-<p> swap must be scoped to
    // embed paragraphs only; plain paragraphs keep their <p>.
    const para = container.querySelector('p');
    expect(para).not.toBeNull();
    expect(para?.textContent).toContain('Just some prose.');
    expect(screen.queryByTestId('embed-callout')).toBeNull();
  });
});
