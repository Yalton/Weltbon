import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnlinkedMentionsPanel } from './UnlinkedMentionsPanel';
import type { Entry, EntryDetail } from '../hooks/useEntries';

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

/**
 * Build a list-shaped Entry row (NO body field — matching the real list projection).
 * The production GET /universes/:uid/entries endpoint does NOT project `body`,
 * so allEntries rows always have body: undefined at runtime (ENT-03 locks this).
 */
function mkListRow(overrides: Partial<Entry> = {}): Entry {
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
    ...overrides,
  };
}

/**
 * Build a detail-shaped EntryDetail (WITH body — as returned by GET /universes/:uid/entries/:id).
 * Used to populate the api mock's response for detail GET calls.
 */
function mkDetail(overrides: Partial<EntryDetail> = {}): EntryDetail {
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
    outboundLinks: [],
    backlinks: [],
    issues: [],
    ...overrides,
  };
}

/** List-row for a sibling entry (no body). */
function mkSourceRow(id: string, overrides: Partial<Entry> = {}): Entry {
  return mkListRow({ id, title: `Source ${id}`, ...overrides });
}

/** Detail response for a sibling (with body). */
function mkSourceDetail(id: string, body: string, overrides: Partial<EntryDetail> = {}): EntryDetail {
  return mkDetail({ id, title: `Source ${id}`, body, ...overrides });
}

/**
 * Set up the api mock so that:
 * - Calls with a detail GET path (no method or method=GET) resolve the given detail object.
 * - Calls with a PATCH (method: 'PATCH') resolve patchResponse (defaults to {}).
 *
 * Multiple detail entries can be registered by passing multiple [id, detail] pairs.
 */
function setupApiMock(
  details: Array<EntryDetail>,
  patchResponse: unknown = {},
) {
  // Build a map from entry id to detail for O(1) lookup.
  const detailMap = new Map<string, EntryDetail>(details.map((d) => [d.id, d]));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (api as any).mockImplementation((path: string, opts?: RequestInit) => {
    if (opts?.method === 'PATCH') {
      return Promise.resolve(patchResponse);
    }
    // For GET calls, find the detail whose id appears at the end of the url path.
    // URL format: /universes/U1/entries/<id>
    const m = typeof path === 'string' ? path.match(/\/entries\/([^/?]+)(?:\?|$)/) : null;
    if (m) {
      const entryId = m[1];
      const detail = detailMap.get(entryId);
      if (detail) {
        return Promise.resolve(detail);
      }
    }
    return Promise.resolve({});
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

  it('shows empty state when no other entries mention the target', async () => {
    const target = mkListRow({ title: 'Empire' });
    setupApiMock([mkDetail({ id: 'E1', body: '' })]);
    renderPanel(target, [target]);
    await waitFor(() => {
      expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
    });
  });

  it('shows heading with count 0 when no mentions', async () => {
    const target = mkListRow({ title: 'Empire' });
    setupApiMock([mkDetail({ id: 'E1', body: '' })]);
    renderPanel(target, [target]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /unlinked mentions \(0\)/i })).toBeInTheDocument();
    });
  });

  // ── Whole-word matching (D-13) ────────────────────────────────────────────

  it('matches the target name as a whole word', async () => {
    const target = mkListRow({ title: 'Sun', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Sun', body: '' }),
      mkSourceDetail('E2', 'The Sun rose over the horizon.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /unlinked mentions \(1\)/i })).toBeInTheDocument();
    });
  });

  it('does NOT match "Sun" inside "Sunday" (whole-word guard)', async () => {
    const target = mkListRow({ title: 'Sun', id: 'E1' });
    const source2 = mkSourceRow('E3');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Sun', body: '' }),
      mkSourceDetail('E3', 'Sunday is a day of rest and unsung heroes.'),
    ]);
    renderPanel(target, [target, source2]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /unlinked mentions \(0\)/i })).toBeInTheDocument();
    });
  });

  it('does NOT match "Sun" when only "Sunday" and "unsung" appear', async () => {
    const target = mkListRow({ title: 'Sun', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Sun', body: '' }),
      mkSourceDetail('E2', 'On Sunday we rest. Heroes are often unsung.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /unlinked mentions \(0\)/i })).toBeInTheDocument();
      expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
    });
  });

  // ── Case-insensitive matching (D-13) ─────────────────────────────────────

  it('matches in a case-insensitive manner', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', 'The empire fell in the third age.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /unlinked mentions \(1\)/i })).toBeInTheDocument();
    });
  });

  // ── Min-length floor (D-13) ───────────────────────────────────────────────

  it('does NOT match names shorter than 3 characters', async () => {
    const target = mkListRow({ title: 'Go', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Go', body: '' }),
      mkSourceDetail('E2', 'Go north to find the Go realm.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
    });
  });

  // ── Skip existing [[ ]] links (D-13) ─────────────────────────────────────

  it('does NOT surface an occurrence already inside a wikilink', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', 'The [[Empire]] ruled for centuries.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
    });
  });

  it('does NOT surface occurrences inside piped wikilinks', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', 'The [[Empire|old realm]] rose and fell.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
    });
  });

  // ── Skip inside code spans (D-13) ────────────────────────────────────────

  it('does NOT surface an occurrence inside a backtick code span', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', 'Use `Empire` for the faction name.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
    });
  });

  it('does NOT surface an occurrence inside a fenced code block', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', 'See:\n```\nEmpire is defined here\n```\nEnd.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
    });
  });

  // ── Both excluded and plain occurrences in the same body ─────────────────

  it('surfaces plain occurrence but not the linked one in the same body', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', 'The [[Empire]] ruled long. The empire still echoes in legend.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /unlinked mentions \(1\)/i })).toBeInTheDocument();
      // Snippet should contain "empire" (the bare one)
      expect(screen.getByText(/empire still echoes/i)).toBeInTheDocument();
    });
  });

  // ── Alias matching ────────────────────────────────────────────────────────

  it('matches an alias of the target entry', async () => {
    const target = mkListRow({ title: 'Empire', aliases: ['The Realm'], id: 'E1' });
    const source = mkSourceRow('E2');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', aliases: ['The Realm'], body: '' }),
      mkSourceDetail('E2', 'The Realm was vast and ancient.'),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /unlinked mentions \(1\)/i })).toBeInTheDocument();
    });
  });

  // ── Source entry self-exclusion ───────────────────────────────────────────

  it('does NOT scan the viewed entry itself', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    // Even if the detail for E1 has body that "mentions" itself, it must be excluded
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: 'Empire is my own body text.' }),
    ]);
    renderPanel(target, [target]);
    await waitFor(() => {
      expect(screen.getByText(/no unlinked mentions found/i)).toBeInTheDocument();
    });
  });

  // ── D-14: Linkify form (bare vs piped) ───────────────────────────────────

  it('D-14: inserts [[Title]] when matched text equals canonical title exactly', async () => {
    const sourceBody = 'The Empire was powerful.';
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    const onLinked = vi.fn();

    // api mock: GET detail calls return the detail with body; PATCH returns {}
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', sourceBody),
    ]);

    renderPanel(target, [target, source], onLinked);

    await userEvent.click(await screen.findByRole('button', { name: /link/i }));

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(
        ([, opts]) => opts?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const callBody = JSON.parse(patchCall![1]!.body as string);
      expect(callBody.body).toContain('[[Empire]]');
      expect(callBody.body).not.toContain('[[Empire|Empire]]');
    });
  });

  it('D-14: inserts [[Title|prose]] when matched text differs in case from canonical title', async () => {
    const sourceBody = 'The empire fell centuries ago.';
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    const onLinked = vi.fn();

    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', sourceBody),
    ]);

    renderPanel(target, [target, source], onLinked);

    await userEvent.click(await screen.findByRole('button', { name: /link/i }));

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(
        ([, opts]) => opts?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const callBody = JSON.parse(patchCall![1]!.body as string);
      expect(callBody.body).toContain('[[Empire|empire]]');
    });
  });

  // ── D-15: Single-occurrence linkify ──────────────────────────────────────

  it('D-15: linkifying one occurrence leaves other occurrences as plain text', async () => {
    const sourceBody = 'Empire rose. Then the Empire fell.';
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    const onLinked = vi.fn();

    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', sourceBody),
    ]);

    renderPanel(target, [target, source], onLinked);

    // There should be 2 mention rows (both occurrences)
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /link/i })).toHaveLength(2);
    });

    // Click the first "Link" button
    const buttons = screen.getAllByRole('button', { name: /link/i });
    await userEvent.click(buttons[0]);

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(
        ([, opts]) => opts?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
    });

    const patchCall = vi.mocked(api).mock.calls.find(
      ([, opts]) => opts?.method === 'PATCH',
    );
    const callBody = JSON.parse(patchCall![1]!.body as string);

    // The rewritten body should contain exactly one wikilink for Empire and
    // one remaining plain-text "Empire"
    const wikilinkCount = (callBody.body.match(/\[\[Empire\]\]/g) ?? []).length;
    const plainCount = (callBody.body.match(/(?<!\[\[)Empire(?!\]\])/g) ?? []).length;

    expect(wikilinkCount).toBe(1);
    expect(plainCount).toBe(1);
  });

  // ── Heading count ─────────────────────────────────────────────────────────

  it('renders the heading with the correct mention count', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const s1 = mkSourceRow('E2');
    const s2 = mkSourceRow('E3');
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', 'The empire fell.'),
      mkSourceDetail('E3', 'Empire of light.'),
    ]);
    renderPanel(target, [target, s1, s2]);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /unlinked mentions \(2\)/i })).toBeInTheDocument();
    });
  });

  // ── Source title shown per row ────────────────────────────────────────────

  it('shows the source entry title in each mention row', async () => {
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = { ...mkSourceRow('E2'), title: 'Chronicle of Ages' };
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', 'The empire was vast.', { title: 'Chronicle of Ages' }),
    ]);
    renderPanel(target, [target, source]);
    await waitFor(() => {
      expect(screen.getByText('Chronicle of Ages')).toBeInTheDocument();
    });
  });

  // ── onLinked callback ─────────────────────────────────────────────────────

  it('calls onLinked after a successful linkify', async () => {
    const sourceBody = 'Empire arose.';
    const target = mkListRow({ title: 'Empire', id: 'E1' });
    const source = mkSourceRow('E2');
    const onLinked = vi.fn();

    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', sourceBody),
    ]);

    renderPanel(target, [target, source], onLinked);

    await userEvent.click(await screen.findByRole('button', { name: /link/i }));

    await waitFor(() => {
      expect(onLinked).toHaveBeenCalledTimes(1);
    });
  });

  // ── REGRESSION: body undefined on list rows must NOT issue a destructive PATCH ─

  it('does NOT issue a destructive PATCH when list rows have body undefined (XREF-06 SC3 regression)', async () => {
    // This test mirrors the production reality: list rows NEVER have body
    // (api/tests/entries.test.ts ENT-03 locks the list projection as body-less).
    // The sibling body is delivered ONLY through the detail endpoint mock.

    const siblingsRealBody = 'The mighty Empire rose from the ashes of the old wars.';

    const target = mkListRow({ title: 'Empire', id: 'E1' });
    // List row for the sibling — NO body field (body: undefined, the real projection)
    const sourceListRow = mkSourceRow('E2');
    // Confirm the list row truly has no body property
    expect((sourceListRow as { body?: string }).body).toBeUndefined();

    const onLinked = vi.fn();

    // Detail mock returns the real body for GET /universes/U1/entries/E2
    setupApiMock([
      mkDetail({ id: 'E1', title: 'Empire', body: '' }),
      mkSourceDetail('E2', siblingsRealBody),
    ]);

    renderPanel(target, [target, sourceListRow], onLinked);

    // Panel should find a mention (scan uses detail body, not the list row's undefined body)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /link/i })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /link/i }));

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(
        ([, opts]) => opts?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const callBody = JSON.parse(patchCall![1]!.body as string);

      // The PATCH body must NOT be just '[[Empire]]' (destructive wipe)
      expect(callBody.body).not.toBe('[[Empire]]');
      expect(callBody.body).not.toBe('[[Empire|empire]]');

      // The PATCH body must contain the inserted wikilink
      expect(callBody.body).toContain('[[Empire]]');

      // The PATCH body must contain a fragment of the original sibling prose
      // (proving the real body was used, not an empty fallback)
      expect(callBody.body).toContain('ashes of the old wars');
    });
  });
});
