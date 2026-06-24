import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnlinkedMentionsPanel } from './UnlinkedMentionsPanel';
import type { Entry } from '../hooks/useEntries';

// Mock the api/client module (same pattern as IssueSection.test.tsx and
// EntryDetail.test.tsx — mock at the module path other tests use).
vi.mock('../api/client', () => ({
  getShareToken: () => null,
  api: vi.fn(),
  getAccessToken: () => null,
}));

import { api } from '../api/client';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mkEntry(overrides: Partial<Entry> & { body?: string } = {}): Entry & { body: string } {
  return {
    id: 'E1',
    universeId: 'U1',
    title: 'Empire',
    entryType: 'faction',
    summary: '',
    tags: [],
    aliases: [],
    meta: {},
    icon: '',
    categoryId: null,
    isPublic: true,
    wip: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    body: '',
    ...overrides,
  } as Entry & { body: string };
}

function mkSource(
  id: string,
  body: string,
  overrides: Partial<Entry> = {},
): Entry & { body: string } {
  return mkEntry({
    id,
    title: `Source ${id}`,
    body,
    ...overrides,
  });
}

function renderPanel(
  entry: Entry,
  allEntries: Entry[],
  onLinked?: () => void,
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <UnlinkedMentionsPanel
        universeId="U1"
        entry={entry}
        allEntries={allEntries}
        onLinked={onLinked}
      />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('UnlinkedMentionsPanel', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  // ── Empty state ───────────────────────────────────────────────────────────

  it('shows empty state when no other entries mention the target', () => {
    const target = mkEntry({ title: 'Empire' });
    renderPanel(target, [target]);
    expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
  });

  it('shows heading with count 0 when no mentions', () => {
    const target = mkEntry({ title: 'Empire' });
    renderPanel(target, [target]);
    expect(screen.getByRole('heading', { name: /unlinked mentions \(0\)/i })).toBeInTheDocument();
  });

  // ── Whole-word matching (D-13) ────────────────────────────────────────────

  it('matches the target name as a whole word', () => {
    const target = mkEntry({ title: 'Sun', id: 'E1' });
    const source = mkSource('E2', 'The Sun rose over the horizon.');
    renderPanel(target, [target, source]);
    expect(screen.getByRole('heading', { name: /unlinked mentions \(1\)/i })).toBeInTheDocument();
  });

  it('does NOT match "Sun" inside "Sunday" (whole-word guard)', () => {
    const target = mkEntry({ title: 'Sun', id: 'E1' });
    const source = mkSource('E2', 'On Sunday we rest. No mention of the sun here in this word.');
    renderPanel(target, [target, source]);
    // "sun" in "Sunday" should not match, but "sun" as a separate word should
    // The source body has "sun" as part of "Sunday" and "sun" as a standalone word
    // We test a body with ONLY "Sunday" (no bare "Sun"):
    const source2 = mkSource('E3', 'Sunday is a day of rest and unsung heroes.');
    renderPanel(target, [target, source2]);
    expect(screen.getAllByRole('heading', { name: /unlinked mentions \(0\)/i })).toHaveLength(1);
  });

  it('does NOT match "Sun" when only "Sunday" and "unsung" appear', () => {
    const target = mkEntry({ title: 'Sun', id: 'E1' });
    const source = mkSource('E2', 'On Sunday we rest. Heroes are often unsung.');
    renderPanel(target, [target, source]);
    expect(screen.getByRole('heading', { name: /unlinked mentions \(0\)/i })).toBeInTheDocument();
    expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
  });

  // ── Case-insensitive matching (D-13) ─────────────────────────────────────

  it('matches in a case-insensitive manner', () => {
    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'The empire fell in the third age.');
    renderPanel(target, [target, source]);
    expect(screen.getByRole('heading', { name: /unlinked mentions \(1\)/i })).toBeInTheDocument();
  });

  // ── Min-length floor (D-13) ───────────────────────────────────────────────

  it('does NOT match names shorter than 3 characters', () => {
    const target = mkEntry({ title: 'Go', id: 'E1' });
    const source = mkSource('E2', 'Go north to find the Go realm.');
    renderPanel(target, [target, source]);
    // "Go" has length 2, below the min-length floor of 3 — no mentions
    expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
  });

  // ── Skip existing [[ ]] links (D-13) ─────────────────────────────────────

  it('does NOT surface an occurrence already inside a wikilink', () => {
    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'The [[Empire]] ruled for centuries.');
    renderPanel(target, [target, source]);
    expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
  });

  it('does NOT surface occurrences inside piped wikilinks', () => {
    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'The [[Empire|old realm]] rose and fell.');
    renderPanel(target, [target, source]);
    expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
  });

  // ── Skip inside code spans (D-13) ────────────────────────────────────────

  it('does NOT surface an occurrence inside a backtick code span', () => {
    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'Use `Empire` for the faction name.');
    renderPanel(target, [target, source]);
    expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
  });

  it('does NOT surface an occurrence inside a fenced code block', () => {
    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'See:\n```\nEmpire is defined here\n```\nEnd.');
    renderPanel(target, [target, source]);
    expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
  });

  // ── Both excluded and plain occurrences in the same body ─────────────────

  it('surfaces plain occurrence but not the linked one in the same body', () => {
    const target = mkEntry({ title: 'Empire', id: 'E1' });
    // One occurrence is linked, one is bare prose — only the prose one surfaces
    const source = mkSource(
      'E2',
      'The [[Empire]] ruled long. The empire still echoes in legend.',
    );
    renderPanel(target, [target, source]);
    expect(screen.getByRole('heading', { name: /unlinked mentions \(1\)/i })).toBeInTheDocument();
    // Snippet should contain "empire" (the bare one)
    expect(screen.getByText(/empire still echoes/i)).toBeInTheDocument();
  });

  // ── Alias matching ────────────────────────────────────────────────────────

  it('matches an alias of the target entry', () => {
    const target = mkEntry({ title: 'Empire', aliases: ['The Realm'], id: 'E1' });
    const source = mkSource('E2', 'The Realm was vast and ancient.');
    renderPanel(target, [target, source]);
    expect(screen.getByRole('heading', { name: /unlinked mentions \(1\)/i })).toBeInTheDocument();
  });

  // ── Source entry self-exclusion ───────────────────────────────────────────

  it('does NOT scan the viewed entry itself', () => {
    const target = mkEntry({
      title: 'Empire',
      id: 'E1',
    });
    // The target body "mentions" itself — must be excluded
    const targetWithBody = { ...target, body: 'Empire is my own body text.' };
    renderPanel(target, [targetWithBody]);
    expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
  });

  // ── D-14: Linkify form (bare vs piped) ───────────────────────────────────

  it('D-14: inserts [[Title]] when matched text equals canonical title exactly', async () => {
    vi.mocked(api).mockResolvedValue({} as Entry);

    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'The Empire was powerful.');
    const onLinked = vi.fn();

    renderPanel(target, [target, source], onLinked);

    await userEvent.click(await screen.findByRole('button', { name: /link/i }));

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalledWith(
        expect.stringContaining('/entries/E2'),
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('[[Empire]]'),
        }),
      );
    });

    // Also confirm the piped form was NOT used
    const callBody = JSON.parse(
      vi.mocked(api).mock.calls[0]?.[1]?.body as string ?? '{}',
    );
    expect(callBody.body).toContain('[[Empire]]');
    expect(callBody.body).not.toContain('[[Empire|Empire]]');
  });

  it('D-14: inserts [[Title|prose]] when matched text differs in case from canonical title', async () => {
    vi.mocked(api).mockResolvedValue({} as Entry);

    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'The empire fell centuries ago.');
    const onLinked = vi.fn();

    renderPanel(target, [target, source], onLinked);

    await userEvent.click(await screen.findByRole('button', { name: /link/i }));

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalledWith(
        expect.stringContaining('/entries/E2'),
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('[[Empire|empire]]'),
        }),
      );
    });
  });

  // ── D-15: Single-occurrence linkify ──────────────────────────────────────

  it('D-15: linkifying one occurrence leaves other occurrences as plain text', async () => {
    vi.mocked(api).mockResolvedValue({} as Entry);

    const target = mkEntry({ title: 'Empire', id: 'E1' });
    // Two "Empire" occurrences in the same source body
    const source = mkSource('E2', 'Empire rose. Then the Empire fell.');
    const onLinked = vi.fn();

    renderPanel(target, [target, source], onLinked);

    // There should be 2 mention rows (both occurrences)
    expect(screen.getAllByRole('button', { name: /link/i })).toHaveLength(2);

    // Click the first "Link" button
    const buttons = screen.getAllByRole('button', { name: /link/i });
    await userEvent.click(buttons[0]);

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    });

    const callBody = JSON.parse(
      vi.mocked(api).mock.calls[0]?.[1]?.body as string ?? '{}',
    );

    // The rewritten body should contain exactly one wikilink for Empire and
    // one remaining plain-text "Empire"
    const wikilinkCount = (callBody.body.match(/\[\[Empire\]\]/g) ?? []).length;
    const plainCount = (callBody.body.match(/(?<!\[\[)Empire(?!\]\])/g) ?? []).length;

    expect(wikilinkCount).toBe(1);
    expect(plainCount).toBe(1);
  });

  // ── Heading count ─────────────────────────────────────────────────────────

  it('renders the heading with the correct mention count', () => {
    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const s1 = mkSource('E2', 'The empire fell.');
    const s2 = mkSource('E3', 'Empire of light.');
    renderPanel(target, [target, s1, s2]);
    expect(screen.getByRole('heading', { name: /unlinked mentions \(2\)/i })).toBeInTheDocument();
  });

  // ── Source title shown per row ────────────────────────────────────────────

  it('shows the source entry title in each mention row', () => {
    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'The empire was vast.');
    source.title = 'Chronicle of Ages';
    renderPanel(target, [target, source]);
    expect(screen.getByText('Chronicle of Ages')).toBeInTheDocument();
  });

  // ── onLinked callback ─────────────────────────────────────────────────────

  it('calls onLinked after a successful linkify', async () => {
    vi.mocked(api).mockResolvedValue({} as Entry);

    const target = mkEntry({ title: 'Empire', id: 'E1' });
    const source = mkSource('E2', 'Empire arose.');
    const onLinked = vi.fn();

    renderPanel(target, [target, source], onLinked);

    await userEvent.click(await screen.findByRole('button', { name: /link/i }));

    await waitFor(() => {
      expect(onLinked).toHaveBeenCalledTimes(1);
    });
  });
});
