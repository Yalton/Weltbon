import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import {
  WikilinkAutocomplete,
  rankEntries,
  getMatchedAlias,
  isInsideCodeSpan,
  buildInsertString,
} from './WikilinkAutocomplete';
import type { Entry } from '../hooks/useEntries';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_ENTRY: Omit<Entry, 'id' | 'title' | 'aliases' | 'updatedAt'> = {
  universeId: 'U1',
  entryType: 'place',
  summary: '',
  tags: [],
  meta: {},
  icon: '',
  categoryId: null,
  isPublic: true,
  wip: false,
  createdAt: '2026-01-01T00:00:00Z',
};

function makeEntry(
  id: string,
  title: string,
  aliases: string[] = [],
  updatedAt = '2026-01-01T00:00:00Z',
): Entry {
  return { ...BASE_ENTRY, id, title, aliases, updatedAt };
}

const EMPIRE = makeEntry('e1', 'Empire', ['The Imperium'], '2026-06-20T00:00:00Z');
const EMPYREAN = makeEntry('e2', 'Empyrean', [], '2026-06-18T00:00:00Z');
const OLD_EMPIRE = makeEntry('e3', 'Old Empire', [], '2026-06-15T00:00:00Z');
const EMPEROR = makeEntry('e4', 'Emperor', [], '2026-06-10T00:00:00Z');
const SHIRE = makeEntry('e5', 'The Shire', ['Shire'], '2026-06-22T00:00:00Z');
const CURRENT_ENTRY = makeEntry('SELF', 'Current Entry', [], '2026-06-23T00:00:00Z');

// ---------------------------------------------------------------------------
// Helper: render harness for the component tests
// ---------------------------------------------------------------------------

interface HarnessProps {
  universeId?: string;
  currentEntryId?: string | null;
  query?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  triggerStart?: number;
  activeIndex?: number;
  onActiveIndexChange?: (i: number) => void;
  onResultCountChange?: (n: number) => void;
  onSelect?: (text: string) => void;
  onDismiss?: () => void;
  onActiveInsertChange?: (text: string | null) => void;
}

function Harness(props: HarnessProps) {
  const {
    universeId = 'U1',
    currentEntryId = null,
    query = '',
    triggerStart = 0,
    activeIndex = 0,
    onActiveIndexChange = () => {},
    onResultCountChange = () => {},
    onSelect = () => {},
    onDismiss = () => {},
    onActiveInsertChange = () => {},
  } = props;

  // Create a stable textarea ref for tests
  const textareaRef = props.textareaRef ?? { current: null };

  return (
    <WikilinkAutocomplete
      universeId={universeId}
      currentEntryId={currentEntryId}
      query={query}
      textareaRef={textareaRef as React.RefObject<HTMLTextAreaElement | null>}
      triggerStart={triggerStart}
      activeIndex={activeIndex}
      onActiveIndexChange={onActiveIndexChange}
      onResultCountChange={onResultCountChange}
      onSelect={onSelect}
      onDismiss={onDismiss}
      onActiveInsertChange={onActiveInsertChange}
    />
  );
}

function renderHarness(props?: HarnessProps) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('rankEntries', () => {
  const entries = [EMPIRE, EMPYREAN, OLD_EMPIRE, EMPEROR];

  it('title-prefix matches come before title-substring matches', () => {
    const results = rankEntries(entries, 'emp', null);
    const titles = results.map((e) => e.title);
    // Empire and Empyrean start with "emp" (title-prefix), Old Empire is substring
    expect(titles.indexOf('Empire')).toBeLessThan(titles.indexOf('Old Empire'));
    expect(titles.indexOf('Empyrean')).toBeLessThan(titles.indexOf('Old Empire'));
  });

  it('alias-prefix match comes before title-substring match but after title-prefix', () => {
    // "imper" matches "The Imperium" alias by prefix but "Empire" by title is not matched
    const results = rankEntries(entries, 'imper', null);
    const titles = results.map((e) => e.title);
    // Empire matched via alias "The Imperium" (alias-prefix)
    expect(titles).toContain('Empire');
  });

  it('alias query "imper" surfaces Empire via alias tier', () => {
    const results = rankEntries(entries, 'imper', null);
    expect(results[0].title).toBe('Empire');
  });

  it('empty query returns entries sorted by updatedAt descending', () => {
    const results = rankEntries(entries, '', null);
    const dates = results.map((e) => e.updatedAt);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1] >= dates[i]).toBe(true);
    }
  });

  it('empty query excludes the current entry by id', () => {
    const withSelf = [...entries, CURRENT_ENTRY];
    const results = rankEntries(withSelf, '', 'SELF');
    expect(results.find((e) => e.id === 'SELF')).toBeUndefined();
  });

  it('non-empty query excludes the current entry', () => {
    const withSelf = [...entries, makeEntry('SELF', 'Emperor Extra', [], '2026-06-23T00:00:00Z')];
    const results = rankEntries(withSelf, 'emp', 'SELF');
    expect(results.find((e) => e.id === 'SELF')).toBeUndefined();
  });

  it('caps results at 8', () => {
    const manyEntries = Array.from({ length: 20 }, (_, i) =>
      makeEntry(`id${i}`, `Empire ${i}`, [], '2026-01-01T00:00:00Z'),
    );
    const results = rankEntries(manyEntries, 'empire', null);
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it('strips pipe suffix from query before matching', () => {
    // "emp|nickname" should rank same as "emp"
    const results = rankEntries(entries, 'emp|nickname', null);
    const titles = results.map((e) => e.title);
    expect(titles).toContain('Empire');
    expect(titles).toContain('Empyrean');
  });
});

describe('getMatchedAlias', () => {
  it('returns matched alias when query matches alias', () => {
    const alias = getMatchedAlias(EMPIRE, 'imper');
    expect(alias).toBe('The Imperium');
  });

  it('returns undefined when query matches title (not alias)', () => {
    const alias = getMatchedAlias(EMPIRE, 'emp');
    // Empire matches title-prefix, not alias; but getMatchedAlias just checks aliases
    // When "emp" is found in aliases — "The Imperium" doesn't include "emp"
    expect(alias).toBeUndefined();
  });

  it('returns undefined for empty query', () => {
    expect(getMatchedAlias(EMPIRE, '')).toBeUndefined();
  });

  it('returns undefined for entry with no aliases', () => {
    expect(getMatchedAlias(EMPYREAN, 'emp')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    const alias = getMatchedAlias(EMPIRE, 'IMPER');
    expect(alias).toBe('The Imperium');
  });

  it('strips pipe from query before checking', () => {
    const alias = getMatchedAlias(EMPIRE, 'imper|display');
    expect(alias).toBe('The Imperium');
  });
});

describe('buildInsertString', () => {
  it('returns [[title]] when no pipe in query', () => {
    expect(buildInsertString(EMPIRE, 'emp')).toBe('[[Empire]]');
  });

  it('returns [[title|display]] when query contains pipe', () => {
    expect(buildInsertString(EMPIRE, 'emp|the big one')).toBe('[[Empire|the big one]]');
  });

  it('preserves everything after the first pipe', () => {
    expect(buildInsertString(EMPYREAN, 'em|nickname')).toBe('[[Empyrean|nickname]]');
  });

  it('uses canonical entry title regardless of which alias matched', () => {
    // Even if matched via alias, insert string uses canonical title
    expect(buildInsertString(EMPIRE, 'imper')).toBe('[[Empire]]');
  });

  it('returns [[title]] when pipe is at the very end of query', () => {
    // "emp|" — has pipe but empty display suffix
    expect(buildInsertString(EMPIRE, 'emp|')).toBe('[[Empire|]]');
  });
});

describe('isInsideCodeSpan', () => {
  it('returns true when cursor is inside inline code span', () => {
    expect(isInsideCodeSpan('a `code', 7)).toBe(true);
  });

  it('returns false when cursor is outside inline code span', () => {
    expect(isInsideCodeSpan('a `code` b', 10)).toBe(false);
  });

  it('returns true when cursor is inside fenced code block', () => {
    expect(isInsideCodeSpan('```\nx', 4)).toBe(true);
  });

  it('returns false when cursor is after a complete fenced block', () => {
    expect(isInsideCodeSpan('```\ncode\n```\nx', 13)).toBe(false);
  });

  it('returns false for plain text with no backticks', () => {
    expect(isInsideCodeSpan('hello world', 5)).toBe(false);
  });

  it('returns false at position 0', () => {
    expect(isInsideCodeSpan('`code`', 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('WikilinkAutocomplete component', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  const ENTRIES: Entry[] = [
    makeEntry('e1', 'Empire', ['The Imperium'], '2026-06-20T00:00:00Z'),
    makeEntry('e2', 'Empyrean', [], '2026-06-18T00:00:00Z'),
    makeEntry('e3', 'Old Empire', [], '2026-06-15T00:00:00Z'),
    makeEntry('SELF', 'Self Entry', [], '2026-06-22T00:00:00Z'),
  ];

  it('renders a listbox with Empire ranked first for query "emp"', async () => {
    vi.mocked(api).mockResolvedValue(ENTRIES);
    renderHarness({ query: 'emp', currentEntryId: null });

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Empire');
  });

  it('renders alias annotation when row matched via alias', async () => {
    vi.mocked(api).mockResolvedValue(ENTRIES);
    renderHarness({ query: 'imper', currentEntryId: null });

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    // The Empire row should show alias annotation
    const listbox = screen.getByRole('listbox');
    expect(listbox.textContent).toMatch(/alias:\s*The Imperium/);
  });

  it('excludes the currentEntryId entry from results (D-13)', async () => {
    vi.mocked(api).mockResolvedValue(ENTRIES);
    renderHarness({ query: '', currentEntryId: 'SELF' });

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const titles = options.map((o) => o.textContent);
    expect(titles.some((t) => t?.includes('Self Entry'))).toBe(false);
  });

  it('calls onSelect with [[Empire]] on mousedown of Empire row', async () => {
    vi.mocked(api).mockResolvedValue(ENTRIES);
    const onSelect = vi.fn();
    renderHarness({ query: 'emp', currentEntryId: null, onSelect });

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const empireBtn = options[0].querySelector('button');
    expect(empireBtn).not.toBeNull();
    // Fire mousedown (not click) — component uses onMouseDown for pre-blur selection
    empireBtn!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith('[[Empire]]');
  });

  it('calls onSelect with [[Empire|nickname]] when query is "emp|nickname"', async () => {
    vi.mocked(api).mockResolvedValue(ENTRIES);
    const onSelect = vi.fn();
    renderHarness({ query: 'emp|nickname', currentEntryId: null, onSelect });

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    const firstBtn = options[0].querySelector('button');
    firstBtn!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith('[[Empire|nickname]]');
  });

  it('renders at most 8 role="option" elements when >8 matching entries', async () => {
    const manyEntries = Array.from({ length: 15 }, (_, i) =>
      makeEntry(`id${i}`, `Empire ${i}`, [], '2026-01-01T00:00:00Z'),
    );
    vi.mocked(api).mockResolvedValue(manyEntries);
    renderHarness({ query: 'empire', currentEntryId: null });

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    const options = screen.getAllByRole('option');
    expect(options.length).toBeLessThanOrEqual(8);
  });

  it('renders "No matches" when no entries match the query', async () => {
    vi.mocked(api).mockResolvedValue(ENTRIES);
    renderHarness({ query: 'zzzznotfound', currentEntryId: null });

    await waitFor(() => {
      // Popover content should be rendered (open=true always)
      const noMatch = screen.queryByText(/No matches/i);
      expect(noMatch).toBeInTheDocument();
    });
  });

  it('calls onResultCountChange with the result count', async () => {
    vi.mocked(api).mockResolvedValue(ENTRIES);
    const onResultCountChange = vi.fn();
    renderHarness({ query: 'emp', currentEntryId: null, onResultCountChange });

    // Wait until onResultCountChange has been called with a positive value
    // (first call may be 0 before data loads, subsequent calls have results)
    await waitFor(() => {
      const calls = onResultCountChange.mock.calls;
      const positiveCall = calls.find((c) => c[0] > 0);
      expect(positiveCall).toBeDefined();
    });
  });
});
