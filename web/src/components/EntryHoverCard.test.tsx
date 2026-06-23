/**
 * Phase 46 Plan 02 — EntryHoverCard behavioral tests.
 *
 * Coverage:
 *   D-01: Click on the resolved entry Link navigates — card never intercepts.
 *   D-04: ⓘ caret is present in the DOM (shown under coarse-pointer); clicking
 *         it opens the card content (not just DOM presence).
 *   D-12/D-13: Cover banner renders when coverImageId is set; omitted when null.
 *   D-13 fallback: empty-summary entry shows a body-derived excerpt after the
 *         lazy useEntry fetch resolves.
 *   Share mode: card wraps the share-subtree Link (ShareModeProvider wired).
 *   XSS: no dangerouslySetInnerHTML (structural assertion via grep, not rendered).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EntryHoverCard } from './EntryHoverCard';
import { ShareModeProvider } from '../contexts/ShareModeContext';
import type { Entry } from '../hooks/useEntries';

// ---------------------------------------------------------------------------
// navigate spy
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// ---------------------------------------------------------------------------
// useEntry mock — lets tests control the lazy body fetch
// ---------------------------------------------------------------------------

const mockUseEntry = vi.fn();

vi.mock('../hooks/useEntries', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useEntries')>('../hooks/useEntries');
  return { ...actual, useEntry: (...args: unknown[]) => mockUseEntry(...args) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function AuthWrapper({ children }: { children: ReactNode }) {
  // Outside ShareModeProvider → useShareMode() returns false (authenticated mode).
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function ShareWrapper({ children }: { children: ReactNode }) {
  // Inside ShareModeProvider → useShareMode() returns true (share mode).
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <ShareModeProvider token="tok123">{children}</ShareModeProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'entry-1',
    universeId: 'u1',
    title: 'Eldoria',
    entryType: 'location',
    summary: 'A shining city on a hill.',
    tags: [],
    aliases: [],
    meta: {},
    icon: '🏙',
    categoryId: null,
    isPublic: true,
    wip: false,
    coverImageId: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

// Default useEntry mock: no data (not called in the common case)
beforeEach(() => {
  mockNavigate.mockClear();
  mockUseEntry.mockClear();
  mockUseEntry.mockReturnValue({ data: undefined, isLoading: false });
});

// ---------------------------------------------------------------------------
// D-01: Click on the Link navigates — card never prevents navigation
// ---------------------------------------------------------------------------

describe('D-01: clicking the link navigates without prevention', () => {
  it('renders a child link that is clickable and fires no preventDefault', () => {
    const entry = makeEntry();
    let clickEvent: MouseEvent | undefined;

    render(
      <AuthWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a
            href="/universes/u1/entries/entry-1"
            data-testid="entry-link"
            onClick={(e) => { clickEvent = e.nativeEvent; }}
          >
            Eldoria
          </a>
        </EntryHoverCard>
      </AuthWrapper>,
    );

    const link = screen.getByTestId('entry-link');
    expect(link).toBeInTheDocument();
    fireEvent.click(link);

    // The card must not have called preventDefault on the click event.
    // clickEvent.defaultPrevented would be true if the card called preventDefault.
    expect(clickEvent?.defaultPrevented).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D-04: ⓘ caret is present in DOM; clicking it opens the card content
// ---------------------------------------------------------------------------

describe('D-04: caret presence and click-to-open', () => {
  it('renders a caret element (D-04 coarse-pointer affordance)', () => {
    const entry = makeEntry();

    render(
      <AuthWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/universes/u1/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </AuthWrapper>,
    );

    // The caret must be present in the DOM regardless of media query
    const caret = screen.getByTestId('entry-hover-caret');
    expect(caret).toBeInTheDocument();
  });

  it('clicking the caret opens the popover content', async () => {
    const entry = makeEntry({ summary: 'A shining city on a hill.' });

    render(
      <AuthWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/universes/u1/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </AuthWrapper>,
    );

    const caret = screen.getByTestId('entry-hover-caret');

    await act(async () => {
      fireEvent.click(caret);
    });

    // After caret click the card content (title) should be visible
    expect(screen.getByTestId('entry-card-title')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Summary present: card shows title, type, summary (no useEntry fetch)
// ---------------------------------------------------------------------------

describe('Card content with non-empty summary', () => {
  it('shows title, type badge, and summary when card is opened', async () => {
    const entry = makeEntry({ summary: 'A shining city on a hill.' });

    render(
      <AuthWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/universes/u1/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </AuthWrapper>,
    );

    const caret = screen.getByTestId('entry-hover-caret');
    await act(async () => { fireEvent.click(caret); });

    expect(screen.getByTestId('entry-card-title')).toHaveTextContent('Eldoria');
    expect(screen.getByText('location')).toBeInTheDocument();
    expect(screen.getByTestId('entry-card-summary')).toBeInTheDocument();
    expect(screen.getByTestId('entry-card-summary')).toHaveTextContent(
      'A shining city on a hill.',
    );

    // useEntry must NOT have been called when summary is present
    expect(mockUseEntry).not.toHaveBeenCalledWith('u1', 'entry-1');
  });
});

// ---------------------------------------------------------------------------
// D-12/D-13: Cover banner present vs absent
// ---------------------------------------------------------------------------

describe('D-12/D-13: cover banner rendered vs omitted', () => {
  it('renders a cover <img> banner when coverImageId is set', async () => {
    const entry = makeEntry({
      coverImageId: 'asset-abc',
      summary: 'Has a cover.',
    });

    render(
      <AuthWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/universes/u1/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </AuthWrapper>,
    );

    const caret = screen.getByTestId('entry-hover-caret');
    await act(async () => { fireEvent.click(caret); });

    const img = screen.getByRole('img');
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toContain('asset-abc');
    expect(img.getAttribute('src')).toContain('/raw');
  });

  it('does NOT render a cover <img> when coverImageId is null', async () => {
    const entry = makeEntry({ coverImageId: null, summary: 'No cover image.' });

    render(
      <AuthWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/universes/u1/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </AuthWrapper>,
    );

    const caret = screen.getByTestId('entry-hover-caret');
    await act(async () => { fireEvent.click(caret); });

    expect(screen.queryByRole('img')).toBeNull();
  });

  it('uses share-mode asset URL when in share mode', async () => {
    const entry = makeEntry({ coverImageId: 'asset-xyz', summary: 'Cover in share.' });

    render(
      <ShareWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/share/tok123/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </ShareWrapper>,
    );

    const caret = screen.getByTestId('entry-hover-caret');
    await act(async () => { fireEvent.click(caret); });

    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toContain('/api/share/assets/asset-xyz/raw');
  });
});

// ---------------------------------------------------------------------------
// D-13 fallback: empty summary → lazy body-derived excerpt
// ---------------------------------------------------------------------------

describe('D-13: empty-summary fallback — lazy body excerpt', () => {
  it('fires useEntry when summary is empty and card is open, then shows excerpt', async () => {
    const entry = makeEntry({ summary: '' });

    // Mock useEntry to return a body — simulates the resolved fetch
    mockUseEntry.mockImplementation((uid: string, eid: string) => {
      if (uid === 'u1' && eid === 'entry-1') {
        return {
          data: {
            ...entry,
            body: '## History\n\nEldoria was founded in ancient times by the elves.',
            outboundLinks: [],
            backlinks: [],
            issues: [],
          },
          isLoading: false,
        };
      }
      return { data: undefined, isLoading: false };
    });

    render(
      <AuthWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/universes/u1/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </AuthWrapper>,
    );

    const caret = screen.getByTestId('entry-hover-caret');
    await act(async () => { fireEvent.click(caret); });

    // The card should show a body-derived excerpt (markdown-stripped)
    const summaryEl = screen.getByTestId('entry-card-summary');
    expect(summaryEl.textContent).not.toBe('');
    // Must contain some prose from the body (markdown-stripped — no ## heading)
    expect(summaryEl.textContent).toContain('Eldoria was founded');
  });

  it('does NOT fire useEntry when summary is non-empty', async () => {
    const entry = makeEntry({ summary: 'Non-empty summary.' });
    mockUseEntry.mockReturnValue({ data: undefined, isLoading: false });

    render(
      <AuthWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/universes/u1/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </AuthWrapper>,
    );

    // Open the card
    const caret = screen.getByTestId('entry-hover-caret');
    await act(async () => { fireEvent.click(caret); });

    // useEntry must have been called with '' as entryId (disabled) when summary is present
    // The hook receives '' as entryId — gated by enabled: !!entryId
    expect(mockUseEntry).not.toHaveBeenCalledWith('u1', 'entry-1');
  });
});

// ---------------------------------------------------------------------------
// Share mode: card renders without error
// ---------------------------------------------------------------------------

describe('Share mode: card works in ShareModeProvider', () => {
  it('renders and opens in share mode without error', async () => {
    const entry = makeEntry({ summary: 'A share-mode entry.' });

    render(
      <ShareWrapper>
        <EntryHoverCard entry={entry} universeId="u1">
          <a href="/share/tok123/entries/entry-1">Eldoria</a>
        </EntryHoverCard>
      </ShareWrapper>,
    );

    const caret = screen.getByTestId('entry-hover-caret');
    await act(async () => { fireEvent.click(caret); });

    expect(screen.getByTestId('entry-card-title')).toHaveTextContent('Eldoria');
  });
});
