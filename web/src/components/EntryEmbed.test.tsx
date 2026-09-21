
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EntryEmbed } from './EntryEmbed';
import { ShareModeProvider } from '../contexts/ShareModeContext';
import type { WikilinkResolutionData } from './WikilinkText';
import type { DictionaryWord } from '../hooks/useDictionary';

// ---------------------------------------------------------------------------
// navigate spy
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// ---------------------------------------------------------------------------
// useEntry mock — lets tests control the embed body fetch
// ---------------------------------------------------------------------------

const mockUseEntry = vi.fn();

vi.mock('../hooks/useEntries', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useEntries')>('../hooks/useEntries');
  return { ...actual, useEntry: (...args: unknown[]) => mockUseEntry(...args) };
});

// ---------------------------------------------------------------------------
// MarkdownRenderer mock — lets us assert body render without full markdown
// ---------------------------------------------------------------------------

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function AuthWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function ShareWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <ShareModeProvider token="tok123">{children}</ShareModeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function makeWikis(overrides: Partial<WikilinkResolutionData> = {}): WikilinkResolutionData {
  return {
    entryTitles: new Map<string, string>(),
    dictionaryWords: new Map<string, DictionaryWord>(),
    universeId: 'u1',
    ...overrides,
  };
}

// Default useEntry mock: no data (not called in the common case)
beforeEach(() => {
  mockNavigate.mockClear();
  mockUseEntry.mockClear();
  // Default: return disabled state (no data, no loading)
  mockUseEntry.mockReturnValue({ data: undefined, isLoading: false, isError: false });
});

// ---------------------------------------------------------------------------
// D-06: self/circular embed — renders circular-notice, NOT callout/body
// ---------------------------------------------------------------------------

describe('D-06: self/circular embed guard', () => {
  it('renders the circular-embed affordance when targetId === currentEntryId', () => {
    const wikis = makeWikis({ currentEntryId: 'entry-self' });

    render(
      <AuthWrapper>
        <EntryEmbed
          targetId="entry-self"
          label="Self Entry"
          currentEntryId="entry-self"
          wikis={wikis}
          universeId="u1"
        />
      </AuthWrapper>,
    );

    // Must render circular notice
    const notice = screen.getByTestId('embed-circular-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toMatch(/circular embed/i);
    expect(notice.textContent).toContain('Self Entry');
  });

  it('does NOT render the callout or MarkdownRenderer for a self-embed', () => {
    const wikis = makeWikis({ currentEntryId: 'entry-self' });

    render(
      <AuthWrapper>
        <EntryEmbed
          targetId="entry-self"
          label="Self Entry"
          currentEntryId="entry-self"
          wikis={wikis}
          universeId="u1"
        />
      </AuthWrapper>,
    );

    // Must NOT render the callout block or body
    expect(screen.queryByTestId('embed-callout')).toBeNull();
    expect(screen.queryByTestId('markdown-renderer')).toBeNull();
  });

  it('does NOT fire useEntry with the real entryId for a self-embed (fetch disabled)', () => {
    const wikis = makeWikis({ currentEntryId: 'entry-self' });

    render(
      <AuthWrapper>
        <EntryEmbed
          targetId="entry-self"
          label="Self Entry"
          currentEntryId="entry-self"
          wikis={wikis}
          universeId="u1"
        />
      </AuthWrapper>,
    );

    // useEntry is called unconditionally (hook rules) but with '' for the self case —
    // passing '' disables via enabled: !!entryId. Should NOT be called with 'entry-self'.
    expect(mockUseEntry).not.toHaveBeenCalledWith('u1', 'entry-self');
  });
});

// ---------------------------------------------------------------------------
// D-10: null targetId — renders unavailable affordance
// ---------------------------------------------------------------------------

describe('D-10: null targetId renders unavailable affordance', () => {
  it('renders the embed-unavailable affordance when targetId is null', () => {
    const wikis = makeWikis();

    render(
      <AuthWrapper>
        <EntryEmbed
          targetId={null}
          label="Unknown Entry"
          currentEntryId={undefined}
          wikis={wikis}
          universeId="u1"
        />
      </AuthWrapper>,
    );

    const affordance = screen.getByTestId('embed-unavailable');
    expect(affordance).toBeInTheDocument();
    expect(affordance.textContent).toMatch(/embed unavailable/i);
    expect(affordance.textContent).toContain('Unknown Entry');
  });

  it('does NOT render the callout block for a null target', () => {
    const wikis = makeWikis();

    render(
      <AuthWrapper>
        <EntryEmbed
          targetId={null}
          label="Unknown Entry"
          currentEntryId={undefined}
          wikis={wikis}
          universeId="u1"
        />
      </AuthWrapper>,
    );

    expect(screen.queryByTestId('embed-callout')).toBeNull();
    expect(screen.queryByTestId('markdown-renderer')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D-09: resolved body renders callout + attribution + MarkdownRenderer
// ---------------------------------------------------------------------------

describe('D-09: resolved body renders the full embed callout', () => {
  it('renders the callout block with attribution Link and body content', () => {
    const wikis = makeWikis({ currentEntryId: 'entry-host' });

    // Mock a successful entry fetch
    mockUseEntry.mockImplementation((uid: string, eid: string) => {
      if (uid === 'u1' && eid === 'entry-target') {
        return {
          data: {
            id: 'entry-target',
            title: 'Eldoria',
            icon: '🏙',
            body: '## History\n\nFounded in ancient times.',
            assetUrls: {},
          },
          isLoading: false,
          isError: false,
        };
      }
      return { data: undefined, isLoading: false, isError: false };
    });

    render(
      <AuthWrapper>
        <EntryEmbed
          targetId="entry-target"
          label="Eldoria"
          currentEntryId="entry-host"
          wikis={wikis}
          universeId="u1"
        />
      </AuthWrapper>,
    );

    // The callout block should render
    const callout = screen.getByTestId('embed-callout');
    expect(callout).toBeInTheDocument();

    // Attribution link should render
    const attrLink = screen.getByTestId('embed-attribution-link');
    expect(attrLink).toBeInTheDocument();
    expect(attrLink.textContent).toContain('Eldoria');
    expect(attrLink.textContent).toContain('↗');

    // Body should render via MarkdownRenderer
    const body = screen.getByTestId('markdown-renderer');
    expect(body).toBeInTheDocument();
    expect(body.textContent).toContain('Founded in ancient times.');
  });
});

// ---------------------------------------------------------------------------
// D-10: fetch error — renders unavailable affordance (non-fatal)
// ---------------------------------------------------------------------------

describe('D-10: fetch error renders unavailable affordance', () => {
  it('renders the embed-unavailable affordance when useEntry returns an error', () => {
    const wikis = makeWikis();

    mockUseEntry.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    render(
      <AuthWrapper>
        <EntryEmbed
          targetId="entry-private"
          label="Private Entry"
          currentEntryId={undefined}
          wikis={wikis}
          universeId="u1"
        />
      </AuthWrapper>,
    );

    const affordance = screen.getByTestId('embed-unavailable');
    expect(affordance).toBeInTheDocument();
    expect(affordance.textContent).toMatch(/embed unavailable/i);
  });
});

// ---------------------------------------------------------------------------
// Loading state — renders without throwing
// ---------------------------------------------------------------------------

describe('Loading state: renders without throwing', () => {
  it('renders a loading placeholder while the body fetch is in-flight', () => {
    const wikis = makeWikis({ currentEntryId: 'entry-host' });

    mockUseEntry.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    // Should not throw
    expect(() =>
      render(
        <AuthWrapper>
          <EntryEmbed
            targetId="entry-target"
            label="Eldoria"
            currentEntryId="entry-host"
            wikis={wikis}
            universeId="u1"
          />
        </AuthWrapper>,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Share mode: attribution link uses share URL
// ---------------------------------------------------------------------------

describe('Share mode: attribution link uses share URL prefix', () => {
  it('builds the entryTo link with /share/:token/entries/:id in share mode', () => {
    const wikis = makeWikis({ currentEntryId: 'entry-host', shareToken: 'tok123', isShareMode: true });

    mockUseEntry.mockImplementation((_uid: string, eid: string) => {
      if (eid === 'entry-target') {
        return {
          data: {
            id: 'entry-target',
            title: 'Eldoria',
            icon: '🏙',
            body: 'Founded long ago.',
            assetUrls: {},
          },
          isLoading: false,
          isError: false,
        };
      }
      return { data: undefined, isLoading: false, isError: false };
    });

    render(
      <ShareWrapper>
        <EntryEmbed
          targetId="entry-target"
          label="Eldoria"
          currentEntryId="entry-host"
          wikis={wikis}
          universeId="u1"
        />
      </ShareWrapper>,
    );

    const attrLink = screen.getByTestId('embed-attribution-link');
    expect(attrLink.getAttribute('href')).toContain('/share/tok123/entries/entry-target');
  });
});
