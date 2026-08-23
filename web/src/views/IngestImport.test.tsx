import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>(
    '../api/client',
  );
  return { ...actual, api: vi.fn(), getAccessToken: () => null };
});
import { api, ApiError } from '../api/client';
import { IngestImport } from './IngestImport';
import type {
  IngestPreview,
  CommitResult,
  SavedDraft,
} from '../types/ingestReview';

const STORAGE_KEY = 'weltbon.import.U1';

function mkPreview(): IngestPreview {
  return {
    summary: {
      markdown_files_parsed: 2,
      non_markdown_files_skipped: 0,
      hidden_paths_filtered: 0,
      duplicate_titles_in_batch: 0,
      unresolved_wikilinks: 0,
    },
    entries: [
      {
        filename: 'alpha.md',
        path: 'alpha.md',
        title: 'Alpha',
        type: 'concept',
        tags: [],
        category: null,
        body: '# Alpha',
        meta: {},
        linksOut: [],
      },
      {
        filename: 'beta.md',
        path: 'beta.md',
        title: 'Beta',
        type: 'concept',
        tags: [],
        category: null,
        body: '# Beta',
        meta: {},
        linksOut: [
          {
            target: 'Gamma',
            label: 'Gamma',
            resolved: false,
          },
        ],
      },
    ],
    warnings: [],
  };
}

function mkCommitResult(): CommitResult {
  return { entryIds: ['e1', 'e2'], linksCreated: 0, categoriesCreated: 0 };
}

function setupBaseApi(
  opts: { commitImpl?: () => Promise<CommitResult> | CommitResult } = {},
) {
  vi.mocked(api).mockImplementation(async (path?: string, init?: RequestInit) => {
    if (!path) return undefined;
    if (path === '/universes/U1') {
      return {
        id: 'U1',
        userId: 'user1',
        name: 'My World',
        description: '',
        entryTypes: ['concept', 'character', 'location'],
        createdAt: '2025-01-01',
        updatedAt: '2025-01-01',
      };
    }
    if (
      path === '/universes/U1/entries' &&
      (!init || init.method === undefined)
    ) {
      return [
        {
          id: 'existing-1',
          universeId: 'U1',
          title: 'PreExisting',
          entryType: 'concept',
          summary: '',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
          createdAt: '2025-01-01',
          updatedAt: '2025-01-01',
        },
      ];
    }
    if (path === '/universes/U1/categories') {
      return { categories: [], uncategorizedCount: 0 };
    }
    if (path === '/universes/U1/ingest' && init?.method === 'POST') {
      return mkPreview();
    }
    if (path === '/universes/U1/ingest/commit' && init?.method === 'POST') {
      return opts.commitImpl ? opts.commitImpl() : mkCommitResult();
    }
    return undefined;
  });
}

function renderImport(qc?: QueryClient) {
  const client =
    qc ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/universes/U1/import']}>
        <Routes>
          <Route path="/universes/:uid/import" element={<IngestImport />} />
          <Route
            path="/universes/:uid/entries"
            element={<div data-testid="entries-list">EntryList stub</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Drive a successful upload through the hidden file input. Mirrors the
 * pattern in ImportUploadStep.test.tsx — fireEvent.change preserves any
 * synthetic file properties.
 */
async function uploadSimpleZip() {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  if (!input) throw new Error('hidden file input not found');
  const file = new File([new Uint8Array(100)], 'vault.zip', {
    type: 'application/zip',
  });
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
  fireEvent.change(input);
  await userEvent.click(screen.getByRole('button', { name: /^Upload$/ }));
}

/** #35: same drive as uploadSimpleZip, but a lone .docx (classifies as kind='md'). */
async function uploadDocx(name = 'Chapter.docx') {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  if (!input) throw new Error('hidden file input not found');
  const file = new File([new Uint8Array(100)], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
  fireEvent.change(input);
  await userEvent.click(screen.getByRole('button', { name: /^Upload$/ }));
}

describe('IngestImport (Phase 12 E2E)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('SC #1 + #2: full happy path — upload, review (reject), commit, navigate, cleared localStorage', async () => {
    setupBaseApi();
    renderImport();

    // After mount → check-draft → upload step.
    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();

    await uploadSimpleZip();

    // Transition to review.
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();

    // SC #1: per-entry preview lists every parsed file.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();

    // SC #2: user can reject one entry — focus Beta then click Reject.
    await userEvent.click(screen.getByRole('option', { name: /Beta/ }));
    await userEvent.click(
      screen.getByRole('button', { name: /Reject this entry/ }),
    );

    // Sticky-bar Commit reflects accepted-count = 1.
    expect(
      await screen.findByRole('button', { name: /Commit 1 entry/ }),
    ).toBeInTheDocument();

    // Click Commit.
    await userEvent.click(
      screen.getByRole('button', { name: /Commit 1 entry/ }),
    );

    // Navigation fires — the entries-list stub appears.
    expect(await screen.findByTestId('entries-list')).toBeInTheDocument();

    // Verify the POST body shape: 1 accepted entry (Alpha), Beta dropped.
    const commitCall = vi
      .mocked(api)
      .mock.calls.find(([p]) => p === '/universes/U1/ingest/commit');
    expect(commitCall).toBeDefined();
    const init = commitCall![1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.entries).toHaveLength(1);
    expect(sentBody.entries[0].title).toBe('Alpha');
    expect(sentBody.entries[0].decision).toEqual({ disposition: 'accept' });

    // localStorage cleared after success.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('SC #3: navigate-away preserves universe — unmount mid-review, no commit POST fires', async () => {
    setupBaseApi();
    const { unmount } = renderImport();

    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadSimpleZip();
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();

    // Simulate user navigating away.
    unmount();

    const commitCalls = vi
      .mocked(api)
      .mock.calls.filter(([p]) => p === '/universes/U1/ingest/commit');
    expect(commitCalls).toHaveLength(0);
  });

  it('SC #4: commit error preserves localStorage — banner shown, draft NOT cleared', async () => {
    setupBaseApi({
      commitImpl: () => {
        throw new ApiError(500, { error: 'db rejected' }, 'Internal error');
      },
    });
    renderImport();

    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadSimpleZip();
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();

    // Verify the draft was saved to localStorage during review.
    await waitFor(() =>
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull(),
    );
    const draftBefore = localStorage.getItem(STORAGE_KEY);

    // Commit (mock throws 500).
    await userEvent.click(
      screen.getByRole('button', { name: /Commit 2 entries/ }),
    );

    // Error banner appears with 'Import failed.' and reassurance copy.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Import failed\./)).toBeInTheDocument();
    expect(screen.getByText(/Your review is saved/)).toBeInTheDocument();

    // localStorage NOT cleared.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(draftBefore);

    // Dismiss the banner returns to review state.
    await userEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('SC #1 (resume): pre-populated draft renders ImportResumePrompt; Continue restores review', async () => {
    setupBaseApi();
    const draft: SavedDraft = {
      preview: mkPreview(),
      decisions: {
        'beta.md': {
          decision: { disposition: 'reject' },
          edits: {},
          metaValid: true,
        },
      },
      savedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    renderImport();

    expect(
      await screen.findByRole('heading', {
        name: /You have an in-progress import/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 entries/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Continue review/ }));

    // Beta is rejected → Commit 1 entry (Alpha is accepted by default).
    expect(
      await screen.findByRole('button', { name: /Commit 1 entry/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('SC #4 + #5 (commit body shape): post-edit fields and dispositions are correct in POST body', async () => {
    setupBaseApi();
    renderImport();

    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadSimpleZip();
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();

    // Edit Alpha's title.
    await userEvent.click(screen.getByRole('option', { name: /Alpha/ }));
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Alpha (renamed)');
    await userEvent.tab();

    // Commit.
    await userEvent.click(
      screen.getByRole('button', { name: /Commit 2 entries/ }),
    );
    expect(await screen.findByTestId('entries-list')).toBeInTheDocument();

    const commitCall = vi
      .mocked(api)
      .mock.calls.find(([p]) => p === '/universes/U1/ingest/commit');
    const sentBody = JSON.parse((commitCall![1] as RequestInit).body as string);

    expect(sentBody.entries).toHaveLength(2);
    const alphaCe = sentBody.entries.find(
      (e: { path: string }) => e.path === 'alpha.md',
    );
    expect(alphaCe.title).toBe('Alpha (renamed)');
    expect(alphaCe.decision).toEqual({ disposition: 'accept' });
    const betaCe = sentBody.entries.find(
      (e: { path: string }) => e.path === 'beta.md',
    );
    expect(betaCe).toBeDefined();
    expect(betaCe.decision).toEqual({ disposition: 'accept' });
    // linksOut preserved with `warning` field stripped per CommitEntry shape.
    expect(betaCe.linksOut).toHaveLength(1);
    expect(betaCe.linksOut[0]).not.toHaveProperty('warning');
  });

  it('SC #5 (query invalidation on success): all expected query keys are invalidated post-commit', async () => {
    setupBaseApi();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderImport(qc);

    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadSimpleZip();
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: /Commit 2 entries/ }),
    );
    expect(await screen.findByTestId('entries-list')).toBeInTheDocument();

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown[] }).queryKey),
    );
    expect(invalidatedKeys).toContain(JSON.stringify(['entries', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['entry', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['categories', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['graph-data', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['relations', 'U1']));
    expect(invalidatedKeys).toContain(JSON.stringify(['universe', 'U1']));
  });

  it('keyboard nav: ArrowDown/ArrowUp/End move focusedPath through filtered entries', async () => {
    setupBaseApi();
    renderImport();

    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadSimpleZip();
    const main = await screen.findByRole('main', { name: /Import review/i });

    // Alpha is auto-focused after parse.
    expect(
      screen.getByRole('option', { name: /Alpha/, selected: true }),
    ).toBeInTheDocument();

    fireEvent.keyDown(main, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /Beta/, selected: true }),
      ).toBeInTheDocument(),
    );

    fireEvent.keyDown(main, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /Alpha/, selected: true }),
      ).toBeInTheDocument(),
    );

    fireEvent.keyDown(main, { key: 'End' });
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /Beta/, selected: true }),
      ).toBeInTheDocument(),
    );
  });

  it('discard draft: confirming clears localStorage and returns to upload step', async () => {
    setupBaseApi();
    renderImport();

    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadSimpleZip();
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull(),
    );

    await userEvent.click(screen.getByRole('button', { name: /Discard draft/ }));

    const dialog = await screen.findByRole('dialog');
    // Disambiguate: there are TWO 'Discard draft' buttons after the dialog
    // opens — one in the sticky bar, one in the dialog. We want the dialog's.
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Discard draft' }),
    );

    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('main', { name: /Import review/i }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // ── issue #54 ───────────────────────────────────────────────────────────────
  // Clearing the draft must also abandon any save still in flight. A decision
  // change queues a 300ms debounced write; discarding (or committing) right
  // afterwards cleared localStorage but left that write pending, so it landed a
  // moment later and resurrected the draft. The user then returns to a "resume
  // your import" prompt for work they deliberately threw away — or, on the
  // commit path, for an import they already completed.
  //
  // This also removes the flakiness that made this file fail intermittently in
  // the full suite: the pending write was racing the assertions, so the same
  // bug showed up as a timing-dependent test rather than as the product defect
  // it actually is.
  it('a save queued just before a discard does not resurrect the draft (#54)', async () => {
    setupBaseApi();
    renderImport();

    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadSimpleZip();
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull(),
    );

    // Queue a write, then discard before the debounce window closes.
    await userEvent.click(
      screen.getByRole('button', { name: /Reject this entry/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Discard draft/ }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Discard draft' }),
    );

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    // The real assertion: still gone once the debounce window has fully
    // elapsed. Without cancellation the queued write lands in here.
    await new Promise((r) => setTimeout(r, 400));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // #35 DOCX-09/DOCX-10: the promotion control's re-request path.
  it('promoting headings re-POSTs with docx_promote_headings=true and swaps the preview', async () => {
    let ingestCalls = 0;
    vi.mocked(api).mockImplementation(
      async (path?: string, init?: RequestInit) => {
        if (!path) return undefined;
        if (path === '/universes/U1') {
          return {
            id: 'U1',
            userId: 'user1',
            name: 'My World',
            description: '',
            entryTypes: ['concept', 'character', 'location'],
            createdAt: '2025-01-01',
            updatedAt: '2025-01-01',
          };
        }
        if (
          path === '/universes/U1/entries' &&
          (!init || init.method === undefined)
        ) {
          return [];
        }
        if (path === '/universes/U1/categories') {
          return { categories: [], uncategorizedCount: 0 };
        }
        if (path === '/universes/U1/ingest' && init?.method === 'POST') {
          ingestCalls += 1;
          const promoted = ingestCalls > 1;
          const preview: IngestPreview = {
            summary: {
              markdown_files_parsed: 0,
              non_markdown_files_skipped: 0,
              hidden_paths_filtered: 0,
              duplicate_titles_in_batch: 0,
              unresolved_wikilinks: 0,
              docx_files_converted: 1,
            },
            entries: [
              {
                filename: 'Chapter.md',
                path: 'Chapter.md',
                title: 'Chapter',
                type: 'concept',
                tags: [],
                category: null,
                body: promoted ? '# Intro\ncontent' : 'flat content',
                meta: {},
                linksOut: [],
              },
            ],
            warnings: [],
            docx: {
              files: [
                {
                  path: 'Chapter.docx',
                  headings: {
                    styled: 0,
                    unstyledCandidates: promoted ? 0 : 6,
                    promoted,
                  },
                  mediaCount: 0,
                },
              ],
            },
          };
          return preview;
        }
        return undefined;
      },
    );

    renderImport();
    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadDocx();
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();

    const promoteButton = await screen.findByRole('button', {
      name: /treat 6 bold paragraphs as headings/i,
    });
    await userEvent.click(promoteButton);

    // The control disappears once the re-fetched preview reports promoted.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /treat .* as headings/i }),
      ).not.toBeInTheDocument();
    });

    const ingestPostCalls = vi
      .mocked(api)
      .mock.calls.filter(
        ([p, i]) =>
          p === '/universes/U1/ingest' &&
          (i as RequestInit | undefined)?.method === 'POST',
      );
    expect(ingestPostCalls).toHaveLength(2);

    const firstBody = (ingestPostCalls[0]![1] as RequestInit).body as FormData;
    expect(firstBody.get('docx_promote_headings')).toBeNull();

    const secondBody = (ingestPostCalls[1]![1] as RequestInit)
      .body as FormData;
    expect(secondBody.get('docx_promote_headings')).toBe('true');
  });

  // Fix-round-1 gap: nothing pinned that the promotion re-request carries
  // the CURRENT split level forward. Without this, omitting split_level
  // would re-run server auto-detection and could silently discard a split
  // choice the user already made (#54's "don't strand a user's edits"
  // precedent, applied to the split-level choice instead of a decision).
  it('carries the current split level forward when promoting headings', async () => {
    let ingestCalls = 0;
    vi.mocked(api).mockImplementation(
      async (path?: string, init?: RequestInit) => {
        if (!path) return undefined;
        if (path === '/universes/U1') {
          return {
            id: 'U1',
            userId: 'user1',
            name: 'My World',
            description: '',
            entryTypes: ['concept', 'character', 'location'],
            createdAt: '2025-01-01',
            updatedAt: '2025-01-01',
          };
        }
        if (
          path === '/universes/U1/entries' &&
          (!init || init.method === undefined)
        ) {
          return [];
        }
        if (path === '/universes/U1/categories') {
          return { categories: [], uncategorizedCount: 0 };
        }
        if (path === '/universes/U1/ingest' && init?.method === 'POST') {
          ingestCalls += 1;
          const promoted = ingestCalls > 1;
          const preview: IngestPreview = {
            summary: {
              markdown_files_parsed: 0,
              non_markdown_files_skipped: 0,
              hidden_paths_filtered: 0,
              duplicate_titles_in_batch: 0,
              unresolved_wikilinks: 0,
              docx_files_converted: 1,
            },
            entries: [
              {
                filename: 'Chapter.md',
                path: 'Chapter.md',
                title: 'Chapter',
                type: 'concept',
                tags: [],
                category: null,
                body: 'flat content',
                meta: {},
                linksOut: [],
              },
            ],
            warnings: [],
            // A user override: detected level is 3, but the preview was
            // requested (or re-requested) at applied level 2. Promotion
            // must not lose that override.
            split: {
              eligible: true,
              detected: 3,
              applied: 2,
              counts: { '2': 1, '3': 1 },
            },
            docx: {
              files: [
                {
                  path: 'Chapter.docx',
                  headings: {
                    styled: 0,
                    unstyledCandidates: promoted ? 0 : 6,
                    promoted,
                  },
                  mediaCount: 0,
                },
              ],
            },
          };
          return preview;
        }
        return undefined;
      },
    );

    renderImport();
    expect(
      await screen.findByRole('heading', { name: /^Import notes$/ }),
    ).toBeInTheDocument();
    await uploadDocx();
    expect(
      await screen.findByRole('main', { name: /Import review/i }),
    ).toBeInTheDocument();

    const promoteButton = await screen.findByRole('button', {
      name: /treat 6 bold paragraphs as headings/i,
    });
    await userEvent.click(promoteButton);

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /treat .* as headings/i }),
      ).not.toBeInTheDocument();
    });

    const ingestPostCalls = vi
      .mocked(api)
      .mock.calls.filter(
        ([p, i]) =>
          p === '/universes/U1/ingest' &&
          (i as RequestInit | undefined)?.method === 'POST',
      );
    expect(ingestPostCalls).toHaveLength(2);

    const secondBody = (ingestPostCalls[1]![1] as RequestInit)
      .body as FormData;
    // The applied level (2, the user's/current choice) is carried forward,
    // NOT the detected level (3) and NOT omitted (which would re-trigger
    // server auto-detection).
    expect(secondBody.get('split_level')).toBe('2');
  });
});
