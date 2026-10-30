import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WikilinkText, tokenize } from './WikilinkText';
import type { WikilinkResolutionData } from './WikilinkText';
import type { DictionaryWord } from '../hooks/useDictionary';
import type { Entry } from '../hooks/useEntries';

// ---------------------------------------------------------------------------
// useEntry mock — needed for EntryEmbed (called inside WikilinkText for embed segments)
// ---------------------------------------------------------------------------

const mockUseEntry = vi.fn();

vi.mock('../hooks/useEntries', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useEntries')>('../hooks/useEntries');
  return { ...actual, useEntry: (...args: unknown[]) => mockUseEntry(...args) };
});

// Default: return no data (embed renders unavailable affordance)
mockUseEntry.mockReturnValue({ data: undefined, isLoading: false, isError: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeWikis(overrides: Partial<WikilinkResolutionData> = {}): WikilinkResolutionData {
  return {
    entryTitles: new Map<string, string>(),
    dictionaryWords: new Map<string, DictionaryWord>(),
    universeId: 'universe-1',
    ...overrides,
  };
}

function renderWikilink(text: string, wikis: WikilinkResolutionData) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <WikilinkText wikis={wikis}>{text}</WikilinkText>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function EmbedWrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WikilinkText — XREF-04 resolution', () => {
  // ── D-03: case-insensitive title lookup ───────────────────────────────────

  it('resolves [[empire]] to entry "Empire" (D-03 case-insensitive title)', () => {
    const wikis = makeWikis({

      entryTitles: new Map([['empire', 'entry-empire-id']]),
    });
    renderWikilink('see [[empire]]', wikis);

    const link = screen.getByRole('link', { name: 'empire' });
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('/universes/universe-1/entries/entry-empire-id');
  });

  // ── D-03 regression guard: exact-case existing links ─────────────────────

  it('resolves [[Empire]] with original exact case under the new lowercase-keyed map (D-03 regression guard)', () => {
    const wikis = makeWikis({
      // Map built with lower key — [[Empire]] should fold to 'empire' and hit it
      entryTitles: new Map([['empire', 'entry-empire-id']]),
    });
    renderWikilink('see [[Empire]]', wikis);

    const link = screen.getByRole('link', { name: 'Empire' });
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('/universes/universe-1/entries/entry-empire-id');
  });

  // ── D-01 slot 2: alias tier ───────────────────────────────────────────────

  it('resolves [[someAlias]] to the entry that carries that alias (D-01 slot 2)', () => {
    const wikis = makeWikis({
      entryTitles: new Map(), // no title match
      entryAliases: new Map([['somealias', 'entry-aliased-id']]),
    });
    renderWikilink('see [[someAlias]]', wikis);

    const link = screen.getByRole('link', { name: 'someAlias' });
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('/universes/universe-1/entries/entry-aliased-id');
  });

  it('resolves [[SomeAlias]] case-insensitively via alias tier', () => {
    const wikis = makeWikis({
      entryTitles: new Map(), // no title match
      entryAliases: new Map([['somealias', 'entry-aliased-id']]),
    });
    renderWikilink('see [[SomeAlias]]', wikis);

    const link = screen.getByRole('link', { name: 'SomeAlias' });
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('/universes/universe-1/entries/entry-aliased-id');
  });

  // ── D-01 precedence: title beats alias ────────────────────────────────────

  it('title match beats alias when same token matches both (D-01 title > alias)', () => {
    const wikis = makeWikis({
      // 'empire' maps to title entry
      entryTitles: new Map([['empire', 'entry-title-id']]),
      // 'empire' also appears as alias of another entry — should NOT win
      entryAliases: new Map([['empire', 'entry-alias-id']]),
    });
    renderWikilink('[[Empire]]', wikis);

    const link = screen.getByRole('link', { name: 'Empire' });
    expect(link.getAttribute('href')).toBe('/universes/universe-1/entries/entry-title-id');
  });

  // ── D-04: created_at tiebreak ─────────────────────────────────────────────

  /**
   * D-04 tiebreak is enforced in EntryDetail's useMemo (map construction).
   * This test validates the Map construction logic that must be applied by callers.
   * Two entries: 'empire' (early created_at) and 'Empire' (later created_at).
   * The caller must build the map by iterating earliest-created_at first so that
   * [[empire]] resolves to the older entry.
   */
  it('resolves to oldest created_at entry when titles collide on case-fold (D-04)', () => {
    // Simulate the caller (EntryDetail) having sorted by created_at ASC and
    // applied the if (!map.has(key)) guard, so only the oldest wins.
    const entryTitles = new Map<string, string>();
    // Oldest created_at = entry-old-id with title 'Empire'
    entryTitles.set('empire', 'entry-old-id'); // first-inserted = oldest
    // A later entry 'empire' (lower-case) would be blocked by the has-guard:
    if (!entryTitles.has('empire')) entryTitles.set('empire', 'entry-new-id');

    const wikis = makeWikis({ entryTitles });
    renderWikilink('[[empire]]', wikis);

    const link = screen.getByRole('link', { name: 'empire' });
    // Must resolve to the oldest-created entry
    expect(link.getAttribute('href')).toBe('/universes/universe-1/entries/entry-old-id');
  });

  // ── display-text [[X|label]] ──────────────────────────────────────────────

  it('renders the label as the visible anchor text for [[X|label]] display-text syntax', () => {
    const wikis = makeWikis({
      entryTitles: new Map([['empire', 'entry-empire-id']]),
    });
    // [[Empire|the great empire]] — label = "the great empire"
    renderWikilink('see [[Empire|the great empire]]', wikis);

    const link = screen.getByRole('link', { name: 'the great empire' });
    expect(link).toBeDefined();
    expect(link.getAttribute('href')).toBe('/universes/universe-1/entries/entry-empire-id');
  });

  // ── Unresolved token → amber affordance ───────────────────────────────────

  it('renders amber unresolved span for tokens not matching title, alias, or dictionary', () => {
    const wikis = makeWikis(); // no entries, no aliases, no dict words
    renderWikilink('[[unknownToken]]', wikis);

    // The amber span has aria-label containing the target name
    const amber = screen.getByLabelText('unknownToken — not found in dictionary');
    expect(amber).toBeDefined();
    // Verify it's NOT a link
    expect(amber.tagName).not.toBe('A');
  });

  // ── share-mode path via entryAliases ─────────────────────────────────────

  it('renders alias link with /share/:token path in share mode', () => {
    const wikis = makeWikis({
      entryTitles: new Map(),
      entryAliases: new Map([['hero', 'entry-hero-id']]),
      isShareMode: true,
      shareToken: 'tok123',
    });
    renderWikilink('[[hero]]', wikis);

    const link = screen.getByRole('link', { name: 'hero' });
    expect(link.getAttribute('href')).toBe('/share/tok123/entries/entry-hero-id');
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('tokenize embed split', () => {
  // ── Direct tokenize() unit tests (white-box) ─────────────────────────────

  it('tokenize("see ![[Empire]]") yields one embed segment with inner "Empire"', () => {
    const segments = tokenize('see ![[Empire]]');
    // Expect: text "see ", then embed "Empire"
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ kind: 'text', text: 'see ' });
    expect(segments[1]).toMatchObject({ kind: 'embed', inner: 'Empire' });
  });

  it('tokenize("see [[Empire]]") still yields kind "wikilink" (regression guard)', () => {
    const segments = tokenize('see [[Empire]]');
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ kind: 'text', text: 'see ' });
    expect(segments[1]).toMatchObject({ kind: 'wikilink', inner: 'Empire' });
  });

  it('mixed "![[A]] and [[B]]" yields embed A, text " and ", wikilink B in order', () => {
    const segments = tokenize('![[A]] and [[B]]');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ kind: 'embed', inner: 'A' });
    expect(segments[1]).toEqual({ kind: 'text', text: ' and ' });
    expect(segments[2]).toMatchObject({ kind: 'wikilink', inner: 'B' });
  });

  it('bare "!" not immediately followed by [[ stays plain text ("wow!" untouched)', () => {
    const segments = tokenize('wow!');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: 'text', text: 'wow!' });
  });

  it('bare "!" before non-[[ stays text ("hello! world")', () => {
    const segments = tokenize('hello! world');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: 'text', text: 'hello! world' });
  });

  // ── WikilinkResolutionData backward-compat type check ────────────────────
  // Verifies the new optional fields compile and are backward-compatible.
  // These assertions are type-level — if the interface lacks the fields,
  // TypeScript will error at compile time and the test file won't compile.

  it('WikilinkResolutionData accepts entriesById, embedDepth, currentEntryId (optional — backward-compat)', () => {
    // Minimal usage without new fields (backward-compat)
    const minimal: WikilinkResolutionData = {
      entryTitles: new Map(),
      dictionaryWords: new Map<string, DictionaryWord>(),
      universeId: 'u1',
    };
    expect(minimal.entriesById).toBeUndefined();
    expect(minimal.embedDepth).toBeUndefined();
    expect(minimal.currentEntryId).toBeUndefined();

    // Full usage with new fields (forward usage)
    const full: WikilinkResolutionData = {
      entryTitles: new Map(),
      dictionaryWords: new Map<string, DictionaryWord>(),
      universeId: 'u1',
      entriesById: new Map<string, Entry>(),
      embedDepth: 0,
      currentEntryId: 'some-entry-id',
    };
    expect(full.entriesById).toBeDefined();
    expect(full.embedDepth).toBe(0);
    expect(full.currentEntryId).toBe('some-entry-id');
  });

  // ── Component integration: ![[entry]] at top level renders EntryEmbed ──

  // ![[Empire]] with embedDepth undefined (top-level) renders EntryEmbed,
  // which calls useEntry. With no data returned (mock default), it renders
  // the unavailable affordance (D-10).

  it('![[Empire]] at top level renders EntryEmbed (unavailable affordance when no body returned)', () => {
    // useEntry returns no data → EntryEmbed renders D-10 unavailable affordance
    mockUseEntry.mockReturnValue({ data: undefined, isLoading: false, isError: false });

    const wikis = makeWikis({
      entryTitles: new Map([['empire', 'entry-empire-id']]),
    });

    render(
      <EmbedWrapper>
        <WikilinkText wikis={wikis}>{'![[Empire]]'}</WikilinkText>
      </EmbedWrapper>,
    );

    // EntryEmbed renders — no body means unavailable affordance (D-10)
    const affordance = screen.getByTestId('embed-unavailable');
    expect(affordance).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('embed branch', () => {
  // ── D-05: ![[Known]] at embedDepth===1 flattens to hover-card link ──────

  it('![[Known]] with embedDepth===1 flattens to a link (D-05 flatten, no recursive embed)', () => {
    const wikis = makeWikis({
      entryTitles: new Map([['empire', 'entry-empire-id']]),
      embedDepth: 1,
    });

    render(
      <EmbedWrapper>
        <WikilinkText wikis={wikis}>{'![[Empire]]'}</WikilinkText>
      </EmbedWrapper>,
    );

    // At embedDepth 1, ![[Empire]] flattens to a regular link (no embed callout)
    expect(screen.queryByTestId('embed-callout')).toBeNull();
    expect(screen.queryByTestId('embed-unavailable')).toBeNull();
    expect(screen.queryByTestId('embed-circular-notice')).toBeNull();
    // Should render as a link to the entry
    const link = screen.getByRole('link', { name: 'Empire' });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/universes/universe-1/entries/entry-empire-id');
  });

  // ── Top-level ![[Unknown]] renders unavailable affordance (D-10) ─────────

  it('![[Unknown]] at top level renders unavailable affordance when target not in maps', () => {
    mockUseEntry.mockReturnValue({ data: undefined, isLoading: false, isError: false });

    const wikis = makeWikis({
      entryTitles: new Map(), // no entry matches 'unknown'
    });

    render(
      <EmbedWrapper>
        <WikilinkText wikis={wikis}>{'![[Unknown]]'}</WikilinkText>
      </EmbedWrapper>,
    );

    // Null targetId → EntryEmbed renders D-10 unavailable affordance
    const affordance = screen.getByTestId('embed-unavailable');
    expect(affordance).toBeInTheDocument();
    expect(affordance.textContent).toContain('Unknown');
  });
});

describe('type star on entry links', () => {
  it('puts the linked entry type star before the label, leaving the accessible name unchanged', () => {
    const empire = { id: 'entry-empire-id', title: 'Empire', entryType: 'faction', summary: 'An old power.' } as Entry;
    const wikis = makeWikis({
      entryTitles: new Map([['empire', empire.id]]),
      entriesById: new Map([[empire.id, empire]]),
    });

    render(
      <EmbedWrapper>
        <WikilinkText wikis={wikis}>{'Ruled by [[Empire]].'}</WikilinkText>
      </EmbedWrapper>,
    );

    const link = screen.getByRole('link', { name: 'Empire' });
    const star = link.querySelector('svg[aria-hidden="true"]');
    expect(star).not.toBeNull();
    expect(link.firstElementChild?.contains(star)).toBe(true);
  });

  it('omits the star when the linked entry is not loaded', () => {
    const wikis = makeWikis({ entryTitles: new Map([['empire', 'entry-empire-id']]) });

    render(
      <EmbedWrapper>
        <WikilinkText wikis={wikis}>{'Ruled by [[Empire]].'}</WikilinkText>
      </EmbedWrapper>,
    );

    expect(screen.getByRole('link', { name: 'Empire' }).querySelector('svg')).toBeNull();
  });
});
