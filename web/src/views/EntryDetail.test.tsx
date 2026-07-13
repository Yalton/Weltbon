import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  getShareToken: () => null,
  api: vi.fn(),
  getAccessToken: () => null,
}));
import { api } from '../api/client';
import { ShareModeProvider } from '../contexts/ShareModeContext';
import { EntryDetail } from './EntryDetail';

function mkEntryDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'E1',
    universeId: 'U1',
    title: 'Gondor',
    entryType: 'location',
    summary: 'A kingdom of men',
    tags: ['kingdom'],
    meta: {},
    icon: '🏰',
    categoryId: null,
    body: '# Realm',
    outboundLinks: [],
    backlinks: [],
    issues: [],
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...overrides,
  };
}

function renderAt(path: string, entry: ReturnType<typeof mkEntryDetail>) {
  vi.mocked(api).mockImplementation(async (p?: string) => {
    if (p === '/universes/U1/entries/E1') return entry;
    // TimelinePinSection issues a GET /timeline; default to empty so the
    // existing EntryDetail tests don't have to think about pin rows.
    if (typeof p === 'string' && p.endsWith('/timeline')) return [];
    return undefined;
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/universes/:uid/entries/:entryId" element={<EntryDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EntryDetail (issues section)', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders the IssueSection with heading and issue rows from entry.issues', async () => {
    renderAt('/universes/U1/entries/E1', mkEntryDetail({
      issues: [
        { id: 'i1', title: 'Name spelled two ways', severity: 'major' },
      ],
    }));

    expect(await screen.findByRole('heading', { name: /issues \(1\)/i })).toBeInTheDocument();
    expect(screen.getByText('Name spelled two ways')).toBeInTheDocument();
  });

  it('renders the empty-state message when entry.issues is empty', async () => {
    renderAt('/universes/U1/entries/E1', mkEntryDetail({ issues: [] }));

    expect(await screen.findByRole('heading', { name: /issues \(0\)/i })).toBeInTheDocument();
    expect(screen.getByText(/no open issues for this entry/i)).toBeInTheDocument();
  });

  it('clicking Flag issue opens the IssueEditor dialog', async () => {
    renderAt('/universes/U1/entries/E1', mkEntryDetail({ issues: [] }));

    await screen.findByRole('heading', { name: /issues \(0\)/i });
    await userEvent.click(screen.getByRole('button', { name: /flag issue/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('EntryDetail (timeline section)', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders the Timeline section with Not pinned + Add pin when entry has no pin', async () => {
    renderAt('/universes/U1/entries/E1', mkEntryDetail({ issues: [] }));

    expect(
      await screen.findByRole('heading', { name: /^timeline$/i }),
    ).toBeInTheDocument();
    // Wait for the timeline query to resolve (renders Loading… first).
    expect(await screen.findByText(/not pinned/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add pin/i })).toBeInTheDocument();
  });
});

// ── Content-Forward Views §5 ────────────────────────────────────────────────
// The detail page reads as an article: every entry gets a hero (cover banner or
// type-hued monogram band) with the title overlaid, and meta fields live in a
// glass infobox column rather than a grid stapled to the bottom of the page.

/** Auth-mode detail render. Title defaults to 'Aldric' so the monogram is 'A'. */
function renderDetail(overrides: Record<string, unknown> = {}) {
  return renderAt(
    '/universes/U1/entries/E1',
    mkEntryDetail({ title: 'Aldric', entryType: 'character', icon: '', ...overrides }),
  );
}

/** Share-mode detail render — same component, mounted under ShareModeProvider. */
function renderDetailInShareMode(overrides: Record<string, unknown> = {}) {
  const entry = mkEntryDetail({
    title: 'Aldric',
    entryType: 'character',
    icon: '',
    ...overrides,
  });
  vi.mocked(api).mockImplementation(async (p?: string) => {
    // In share mode EntryDetail substitutes 'share' for the missing :uid param.
    if (p === '/universes/share/entries/E1') return entry;
    if (typeof p === 'string' && p.endsWith('/timeline')) return [];
    return undefined;
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ShareModeProvider token="tok1">
        <MemoryRouter initialEntries={['/share/tok1/entries/E1']}>
          <Routes>
            <Route path="/share/:token/entries/:entryId" element={<EntryDetail />} />
          </Routes>
        </MemoryRouter>
      </ShareModeProvider>
    </QueryClientProvider>,
  );
}

describe('Content-Forward Views §5 — hero + infobox', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders a cover hero with the title overlaid when the entry has a cover', async () => {
    // coverImageUrl is the DETAIL endpoint's pre-signed RAW url (not the list's thumb).
    renderDetail({ coverImageUrl: '/api/universes/u1/assets/a1/raw?e=1&s=ff' });

    const hero = await screen.findByTestId('entry-hero');
    const img = within(hero).getByRole('img', { name: /cover/i });
    expect(img).toHaveAttribute('src', '/api/universes/u1/assets/a1/raw?e=1&s=ff');
    // The title lives INSIDE the hero, not in a separate header block above it.
    expect(within(hero).getByRole('heading', { name: 'Aldric' })).toBeInTheDocument();
  });

  it('renders a type-hued watermark-monogram band when the entry has NO cover', async () => {
    renderDetail({ coverImageUrl: null, coverImageId: null });

    const hero = await screen.findByTestId('entry-hero');
    expect(within(hero).queryByRole('img')).not.toBeInTheDocument();
    // Every entry gets a hero — a bare entry is not left with a naked <h1>.
    expect(within(hero).getByTestId('hero-monogram')).toHaveTextContent('A');
    expect(within(hero).getByRole('heading', { name: 'Aldric' })).toBeInTheDocument();
  });

  it('does not render the cover twice (the old inline <img> is gone)', async () => {
    // The old markup rendered the cover between the header and the body. The hero replaces
    // it — if both shipped, the page would show the same image twice.
    renderDetail({ coverImageUrl: '/api/universes/u1/assets/a1/raw?e=1&s=ff' });
    await screen.findByTestId('entry-hero');
    expect(screen.getAllByRole('img', { name: /cover/i })).toHaveLength(1);
  });

  it('presents meta fields in a glass infobox', async () => {
    renderDetail({ meta: { Era: 'First Age', House: 'Vale' } });
    const infobox = await screen.findByTestId('entry-infobox');
    expect(within(infobox).getByText('Era')).toBeInTheDocument();
    expect(within(infobox).getByText('First Age')).toBeInTheDocument();
  });

  it('omits the infobox entirely when the entry has no meta fields', async () => {
    renderDetail({ meta: {} });
    await screen.findByTestId('entry-hero');
    expect(screen.queryByTestId('entry-infobox')).not.toBeInTheDocument();
  });

  it('renders the hero in share mode too', async () => {
    // Same component serves the public share page — the hero must not be auth-only.
    renderDetailInShareMode({ coverImageUrl: '/api/share/assets/a1/raw?u=u1&e=1&s=ff' });
    const hero = await screen.findByTestId('entry-hero');
    expect(within(hero).getByRole('img', { name: /cover/i })).toHaveAttribute(
      'src',
      '/api/share/assets/a1/raw?u=u1&e=1&s=ff',
    );
  });
});
