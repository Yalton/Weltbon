/**
 * WikilinkText resolver tests — Phase 45 Plan 02 (XREF-04).
 *
 * Tests (RED phase):
 *  1. D-03: case-insensitive title match — [[empire]] resolves to entry "Empire"
 *  2. D-03 regression guard: exact-case [[Entry Title]] still resolves correctly
 *  3. D-01 slot 2: alias match → Link (by alias → entryId map)
 *  4. D-01 precedence: title beats alias — token matching both a title and another entry's alias resolves to the title entry
 *  5. D-04: oldest created_at wins on case-fold title collision (verified via EntryDetail map construction)
 *  6. display-text [[X|label]] renders label as visible anchor
 *  7. unresolved token still renders amber affordance
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { WikilinkText } from './WikilinkText';
import type { WikilinkResolutionData } from './WikilinkText';
import type { DictionaryWord } from '../hooks/useDictionary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    <MemoryRouter>
      <WikilinkText wikis={wikis}>{text}</WikilinkText>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WikilinkText — Phase 45 XREF-04 resolution', () => {
  // ── D-03: case-insensitive title lookup ───────────────────────────────────

  it('resolves [[empire]] to entry "Empire" (D-03 case-insensitive title)', () => {
    const wikis = makeWikis({
      // Build map with lowercased key — new Phase 45 convention
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
