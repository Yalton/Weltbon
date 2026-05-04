import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../../hooks/useCategories', () => ({
  useCategories: vi.fn(() => ({
    data: { categories: [], uncategorizedCount: 0 },
    isLoading: false,
  })),
}));

import { ImportDetailPane, type ImportDetailPaneProps } from '../ImportDetailPane';
import type {
  PreviewEntry,
  EntryEdits,
  CommitDecision,
  LinkOut,
} from '../../../types/ingestReview';

const baseEntry: PreviewEntry = {
  filename: 'foo.md',
  path: 'notes/foo.md',
  title: 'Foo',
  type: 'concept',
  tags: ['kingdom'],
  category: null,
  body: '# Foo body\n\nSome content.',
  meta: {},
  linksOut: [],
};

function renderPane(overrides: Partial<ImportDetailPaneProps> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const props: ImportDetailPaneProps = {
    entry: baseEntry,
    edits: {} as EntryEdits,
    decision: { disposition: 'accept' } as CommitDecision,
    validTypes: ['concept', 'character', 'location'],
    universeId: 'U1',
    matchedTitle: null,
    existingTitlesLower: new Set<string>(),
    onUpdateField: vi.fn(),
    onUpdateDecision: vi.fn(),
    onReject: vi.fn(),
    onRestore: vi.fn(),
    onMetaValidityChange: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <QueryClientProvider client={qc}>
      <ImportDetailPane {...props} />
    </QueryClientProvider>,
  );
  return { ...utils, props, qc };
}

describe('ImportDetailPane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('typing in title input + blur calls onUpdateField("title", value)', async () => {
    const user = userEvent.setup();
    const { props } = renderPane();
    const title = screen.getByLabelText(/^title$/i) as HTMLInputElement;
    expect(title.value).toBe('Foo');
    await user.clear(title);
    await user.type(title, 'Foo Renamed');
    await user.tab();
    expect(props.onUpdateField).toHaveBeenCalledWith('title', 'Foo Renamed');
  });

  it('blur with unchanged title does NOT call onUpdateField', async () => {
    const user = userEvent.setup();
    const { props } = renderPane();
    const title = screen.getByLabelText(/^title$/i);
    title.focus();
    await user.tab();
    // No call should have been made for "title"
    const titleCalls = (props.onUpdateField as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'title',
    );
    expect(titleCalls.length).toBe(0);
  });

  it('empty title shows "Title is required" with role=alert', async () => {
    const user = userEvent.setup();
    renderPane();
    const title = screen.getByLabelText(/^title$/i);
    await user.clear(title);
    expect(screen.getByRole('alert')).toHaveTextContent(/Title is required/i);
  });

  it('type select changing value calls onUpdateField("entryType", newType)', async () => {
    const user = userEvent.setup();
    const { props } = renderPane();
    const select = screen.getByLabelText(/^type$/i) as HTMLSelectElement;
    await user.selectOptions(select, 'character');
    expect(props.onUpdateField).toHaveBeenCalledWith('entryType', 'character');
  });

  it('type-not-in-universe defensive case shows inline error text BELOW the select (NOT a disabled <option>)', () => {
    renderPane({
      entry: { ...baseEntry, type: 'mythos' },
      validTypes: ['concept', 'character'],
    });
    expect(
      screen.getByText(/"mythos" isn't a type in this universe/i),
    ).toBeInTheDocument();
    // Assert NO disabled option present (UI-SPEC OVERRIDE §5.2)
    const opts = screen.getAllByRole('option');
    for (const opt of opts) {
      expect(opt).not.toHaveAttribute('disabled');
    }
  });

  it('renders TagInput with existing tags', () => {
    renderPane({ entry: { ...baseEntry, tags: ['kingdom', 'realm'] } });
    expect(screen.getByText('kingdom')).toBeInTheDocument();
    expect(screen.getByText('realm')).toBeInTheDocument();
  });

  it('Body Edit/Preview toggle: Edit shows textarea, Preview swaps to MarkdownRenderer', async () => {
    const user = userEvent.setup();
    renderPane({ entry: { ...baseEntry, body: '# Heading\n\nbody' } });
    const textarea = screen.getByLabelText(/^body$/i, {
      selector: 'textarea',
    }) as HTMLTextAreaElement;
    expect(textarea.value).toContain('# Heading');
    await user.click(screen.getByRole('button', { name: /^preview$/i }));
    // After swap, the textarea is gone, the MarkdownRenderer prose container is rendered
    expect(
      screen.queryByLabelText(/^body$/i, { selector: 'textarea' }),
    ).not.toBeInTheDocument();
    // ReactMarkdown renders the heading as an actual <h1>
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
  });

  it('typing in body textarea + blur calls onUpdateField("body", newBody)', async () => {
    const user = userEvent.setup();
    const { props } = renderPane();
    const textarea = screen.getByLabelText(/^body$/i, { selector: 'textarea' });
    await user.click(textarea);
    await user.keyboard(' more');
    await user.tab();
    expect(props.onUpdateField).toHaveBeenCalledWith(
      'body',
      '# Foo body\n\nSome content. more',
    );
  });

  it('warnings: renders one amber pill per unresolved link, resolved links do NOT appear there', () => {
    const linksOut: LinkOut[] = [
      { target: 'Foo', label: 'Foo', resolved: false },
      { target: 'Bar', label: 'Bar', resolved: false },
      { target: 'Baz', label: 'Baz', resolved: true },
    ];
    renderPane({ entry: { ...baseEntry, linksOut } });
    // The "Warnings" section heading should be present
    const warningsHeading = screen.getByRole('heading', { name: /^warnings$/i });
    const warningsRegion = warningsHeading.parentElement!;
    const fooBadge = within(warningsRegion).getByText(/Unresolved link: Foo/i);
    const barBadge = within(warningsRegion).getByText(/Unresolved link: Bar/i);
    expect(fooBadge).toBeInTheDocument();
    expect(barBadge).toBeInTheDocument();
    expect(within(warningsRegion).queryByText(/Unresolved link: Baz/i)).not.toBeInTheDocument();
  });

  it('no warnings section renders when no unresolved links exist', () => {
    renderPane({
      entry: {
        ...baseEntry,
        linksOut: [{ target: 'Bar', label: 'Bar', resolved: true }],
      },
    });
    expect(screen.queryByRole('heading', { name: /^warnings$/i })).not.toBeInTheDocument();
  });

  it('conflict banner: matchedTitle="Foo" + decision=skip renders banner at top with skip-body copy', () => {
    renderPane({
      matchedTitle: 'Foo',
      decision: { disposition: 'skip' },
      existingTitlesLower: new Set<string>(['foo']),
    });
    expect(
      screen.getByRole('heading', { name: /Conflict — title already exists/i }),
    ).toBeInTheDocument();
  });

  it('conflict banner: matchedTitle=null does NOT render the banner', () => {
    renderPane({ matchedTitle: null });
    expect(
      screen.queryByRole('heading', { name: /Conflict — title already exists/i }),
    ).not.toBeInTheDocument();
  });

  it('reject button: clicking calls onReject; aria-pressed=false', async () => {
    const user = userEvent.setup();
    const { props } = renderPane();
    const reject = screen.getByRole('button', { name: /Reject this entry/i });
    expect(reject).toHaveAttribute('aria-pressed', 'false');
    await user.click(reject);
    expect(props.onReject).toHaveBeenCalledTimes(1);
  });

  it('restore button: when disposition=reject, restore renders with aria-pressed=true and click calls onRestore', async () => {
    const user = userEvent.setup();
    const { props } = renderPane({ decision: { disposition: 'reject' } });
    const restore = screen.getByRole('button', { name: /Restore this entry/i });
    expect(restore).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /Reject this entry/i })).not.toBeInTheDocument();
    await user.click(restore);
    expect(props.onRestore).toHaveBeenCalledTimes(1);
  });

  it('IngestCategoryPicker is rendered (smoke test — its behavior covered by Task 1 tests)', () => {
    renderPane();
    // The picker renders a select; for an empty categories list the
    // first option is "Uncategorized"
    expect(screen.getByLabelText(/^category$/i)).toBeInTheDocument();
  });

  it('re-syncs titleDraft and bodyDraft when entry.path changes (focus switch)', () => {
    const { rerender, qc } = renderPane();
    let title = screen.getByLabelText(/^title$/i) as HTMLInputElement;
    expect(title.value).toBe('Foo');

    const second: PreviewEntry = {
      ...baseEntry,
      path: 'notes/bar.md',
      title: 'Bar',
      body: 'Bar body',
    };
    rerender(
      <QueryClientProvider client={qc}>
        <ImportDetailPane
          entry={second}
          edits={{}}
          decision={{ disposition: 'accept' }}
          validTypes={['concept', 'character', 'location']}
          universeId="U1"
          matchedTitle={null}
          existingTitlesLower={new Set<string>()}
          onUpdateField={vi.fn()}
          onUpdateDecision={vi.fn()}
          onReject={vi.fn()}
          onRestore={vi.fn()}
          onMetaValidityChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    title = screen.getByLabelText(/^title$/i) as HTMLInputElement;
    expect(title.value).toBe('Bar');
    const textarea = screen.getByLabelText(/^body$/i, {
      selector: 'textarea',
    }) as HTMLTextAreaElement;
    expect(textarea.value).toBe('Bar body');
  });

  it('meta validity bubble: passing duplicate keys via edits.meta does NOT itself trigger validity false (validity is computed by MetaEditor on row interaction); calling renders without crash and validity callback present', () => {
    // Smoke test that onMetaValidityChange is wired through and gets called by MetaEditor
    const onMetaValidityChange = vi.fn();
    renderPane({ onMetaValidityChange });
    // MetaEditor calls onValidityChange on mount once with current validity (true for empty)
    expect(onMetaValidityChange).toHaveBeenCalled();
  });
});
