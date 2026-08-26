import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AssetSummary } from '../hooks/useAssets';
import type { Backlink, Entry } from '../hooks/useEntries';

vi.mock('../api/client', () => ({
  getShareToken: () => null,
  api: vi.fn(),
}));
import { api } from '../api/client';
import { EntryEditor } from './EntryEditor';

// Mock api dispatch by URL. Covers /universes/:uid, /universes/:uid/entries,
// /universes/:uid/categories, and the POST create-entry call.
function setupApi({
  universe,
  categories,
  createResponse,
}: {
  universe: { entryTypes: string[] };
  categories: Array<{ id: string; label: string; icon: string; sortOrder: number; entryCount: number }>;
  createResponse: { id: string };
}) {
  vi.mocked(api).mockImplementation(async (path?: string, init?: RequestInit) => {
    if (!path) return undefined;
    if (path.startsWith('/universes/U1/categories')) {
      return { categories, uncategorizedCount: 0 };
    }
    if (path === '/universes/U1') {
      return universe;
    }
    if (path === '/universes/U1/entries' && !init?.method) {
      return [];
    }
    if (path === '/universes/U1/assets' && !init?.method) {
      return [];
    }
    if (path === '/universes/U1/entries' && init?.method === 'POST') {
      return createResponse;
    }
    return undefined;
  });
}

function renderEditor(opts?: { state?: unknown }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const initialEntry = opts?.state
    ? { pathname: '/universes/U1/entries/new', state: opts.state }
    : '/universes/U1/entries/new';
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/universes/:uid/entries/new" element={<EntryEditor />} />
          <Route path="/universes/:uid/entries/:entryId" element={<div>Entry detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EntryEditor category picker', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders the category picker with Uncategorized + categories from useCategories', async () => {
    setupApi({
      universe: { entryTypes: ['character', 'place'] },
      categories: [
        { id: 'c1', label: 'Characters', icon: '🧝', sortOrder: 0, entryCount: 0 },
        { id: 'c2', label: 'Places', icon: '🗺', sortOrder: 1, entryCount: 0 },
      ],
      createResponse: { id: 'new-id' },
    });

    renderEditor();

    const select = (await screen.findByLabelText(/category/i)) as HTMLSelectElement;
    // Wait for categories to load
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThanOrEqual(3);
    });

    const optionTexts = Array.from(select.options).map((o) => o.textContent);
    expect(optionTexts[0]).toMatch(/uncategorized/i);
    expect(optionTexts).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Characters/),
        expect.stringMatching(/Places/),
      ]),
    );
  });

  it('submits categoryId in the create-entry payload when a category is selected', async () => {
    setupApi({
      universe: { entryTypes: ['character'] },
      categories: [
        { id: 'c1', label: 'Characters', icon: '🧝', sortOrder: 0, entryCount: 0 },
      ],
      createResponse: { id: 'new-id' },
    });

    renderEditor();

    // Wait for category options to load
    const select = (await screen.findByLabelText(/category/i)) as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBeGreaterThanOrEqual(2);
    });

    await userEvent.type(await screen.findByLabelText(/title/i), 'Frodo');

    const typeSelect = screen.getByLabelText(/type/i) as HTMLSelectElement;
    await userEvent.selectOptions(typeSelect, 'character');

    await userEvent.selectOptions(select, 'c1');

    await userEvent.click(screen.getByRole('button', { name: /create entry/i }));

    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls;
      const createCall = calls.find(([path, init]) =>
        path === '/universes/U1/entries' && (init as RequestInit)?.method === 'POST',
      );
      expect(createCall).toBeDefined();
      const body = JSON.parse((createCall![1] as RequestInit).body as string);
      expect(body.categoryId).toBe('c1');
      expect(body.title).toBe('Frodo');
      expect(body.entryType).toBe('character');
    });
  });
});

describe('EntryEditor template prefill (POL-04)', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('pre-fills entryType, body, and meta from location.state.template on mount (D-10 array shape)', async () => {
    setupApi({
      universe: { entryTypes: ['location', 'character'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });

    renderEditor({
      state: {
        template: {
          id: 'location-settlement',
          label: 'Location-Settlement',
          entryType: 'location',
          summary: '',
          body: '## Geography\n\n## Population\n',
          // D-09/D-10: new array shape (metaArrayToRecord transforms on read path)
          meta: [
            { name: 'region', default_value: '' },
            { name: 'climate', default_value: '' },
          ],
        },
      },
    });

    const typeSelect = (await screen.findByLabelText(/type/i)) as HTMLSelectElement;
    await waitFor(() => {
      expect(typeSelect.value).toBe('location');
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Source' }));
    const bodySource = (await screen.findByRole('textbox', { name: 'Entry body' })) as HTMLTextAreaElement;
    expect(bodySource.value).toContain('## Geography');

    // Meta keys 'region' and 'climate' both render as Key inputs
    const keyInputs = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    const keyValues = keyInputs.map((i) => i.value).sort();
    expect(keyValues).toEqual(['climate', 'region']);
  });

  it('disables Save when MetaEditor reports invalid (duplicate keys)', async () => {
    setupApi({
      universe: { entryTypes: ['character'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });

    // Start with one meta key 'foo' so we can produce duplicates
    renderEditor({
      state: {
        template: {
          id: 'character-detailed',
          label: 'Character-Detailed',
          entryType: 'character',
          summary: '',
          body: '',
          // D-09/D-10: new array shape
          meta: [{ name: 'foo', default_value: 'a' }],
        },
      },
    });

    // Wait for the prefilled meta row to render
    await screen.findByDisplayValue('foo');

    const submitBtn = screen.getByRole('button', {
      name: /create entry/i,
    }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    // Add a second meta row with the same key 'foo'
    await userEvent.click(screen.getByRole('button', { name: /\+ add field/i }));
    const keyInputs = screen.getAllByPlaceholderText('Key') as HTMLInputElement[];
    await userEvent.type(keyInputs[1], 'foo');

    // Save should now be disabled due to dup
    await waitFor(() => {
      expect(submitBtn.disabled).toBe(true);
    });
  });

  it('submits the exact Markdown changed through the authoring editor', async () => {
    setupApi({
      universe: { entryTypes: ['character'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });
    renderEditor();

    await userEvent.type(await screen.findByLabelText(/title/i), 'Frodo');
    await userEvent.selectOptions(screen.getByLabelText(/type/i), 'character');
    await userEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Entry body' }), {
      target: { value: '## Quest\n\n[[Mordor]]\n\n![map](asset://asset-1)' },
    });
    await userEvent.click(screen.getByRole('button', { name: /create entry/i }));

    await waitFor(() => {
      const createCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        path === '/universes/U1/entries' && (init as RequestInit)?.method === 'POST',
      );
      expect(createCall).toBeDefined();
      expect(JSON.parse((createCall![1] as RequestInit).body as string).body).toBe(
        '## Quest\n\n[[Mordor]]\n\n![map](asset://asset-1)',
      );
    });
  });
});

describe('EntryEditor kebab + SaveAsTemplateDialog (28-06)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    // Reset body pointer-events left over from Radix Dialog/DismissableLayer in jsdom
    document.body.style.removeProperty('pointer-events');
    document.body.removeAttribute('data-scroll-locked');
  });

  it('renders the kebab "Entry actions" button in create mode', async () => {
    setupApi({
      universe: { entryTypes: ['entity'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });

    renderEditor();

    // The kebab button should be in the form actions row
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entry actions' })).toBeInTheDocument();
    });
  });

  it('renders the kebab "Entry actions" button in edit mode', async () => {
    vi.mocked(api).mockImplementation(async (path?: string, init?: RequestInit) => {
      if (!path) return undefined;
      if (path === '/universes/U1') return { entryTypes: ['entity'] };
      if (path.startsWith('/universes/U1/categories')) return { categories: [], uncategorizedCount: 0 };
      if (path === '/universes/U1/entries/E1')
        return {
          id: 'E1',
          title: 'My Hero',
          entryType: 'entity',
          summary: '',
          body: '',
          icon: '',
          tags: [],
          meta: {},
          categoryId: null,
        };
      if (path === '/universes/U1/entries' && !init?.method) return [];
      if (path === '/universes/U1/assets' && !init?.method) return [];
      return undefined;
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/universes/U1/entries/E1/edit']}>
          <Routes>
            <Route path="/universes/:uid/entries/:entryId/edit" element={<EntryEditor />} />
            <Route path="/universes/:uid/entries/:entryId" element={<div>Entry detail</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entry actions' })).toBeInTheDocument();
    });
  });

  it('opens SaveAsTemplateDialog when "Save as template…" is clicked in the dropdown', async () => {
    setupApi({
      universe: { entryTypes: ['entity'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });

    renderEditor();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entry actions' })).toBeInTheDocument();
    });

    // Click kebab
    await userEvent.click(screen.getByRole('button', { name: 'Entry actions' }));

    // Menu item "Save as template…" should appear
    await waitFor(() => {
      expect(screen.getByText('Save as template…')).toBeInTheDocument();
    });

    // Click the menu item
    await userEvent.click(screen.getByText('Save as template…'));

    // The dialog should now be open (dialog title visible)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Save as template' })).toBeInTheDocument();
    });

    // Close the dialog to avoid pointer-events leaking into next tests
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Save as template' })).not.toBeInTheDocument();
    });
  });

  it('forwards templateId from location.state into POST /entries payload (D-16)', async () => {
    setupApi({
      universe: { entryTypes: ['entity'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });

    renderEditor({
      state: {
        templateId: 'tmpl-uuid-123',
      },
    });

    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.type(await screen.findByLabelText(/title/i), 'My Hero');
    const typeSelect = screen.getByLabelText(/type/i) as HTMLSelectElement;
    await user.selectOptions(typeSelect, 'entity');

    await user.click(screen.getByRole('button', { name: /create entry/i }));

    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls;
      const createCall = calls.find(([path, init]) =>
        path === '/universes/U1/entries' && (init as RequestInit)?.method === 'POST',
      );
      expect(createCall).toBeDefined();
      const body = JSON.parse((createCall![1] as RequestInit).body as string);
      expect(body.templateId).toBe('tmpl-uuid-123');
    });
  });

  it('does NOT include templateId in POST /entries when location.state has no templateId', async () => {
    setupApi({
      universe: { entryTypes: ['entity'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });

    renderEditor();

    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await user.type(await screen.findByLabelText(/title/i), 'My Hero');
    const typeSelect = screen.getByLabelText(/type/i) as HTMLSelectElement;
    await user.selectOptions(typeSelect, 'entity');

    await user.click(screen.getByRole('button', { name: /create entry/i }));

    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls;
      const createCall = calls.find(([path, init]) =>
        path === '/universes/U1/entries' && (init as RequestInit)?.method === 'POST',
      );
      expect(createCall).toBeDefined();
      const body = JSON.parse((createCall![1] as RequestInit).body as string);
      expect(body.templateId).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 47 XREF-01 — Wikilink autocomplete integration tests
// ---------------------------------------------------------------------------

// Test entries for the wikilink picker
const BASE_ENTRY_FIXTURE: Omit<Entry, 'id' | 'title' | 'aliases' | 'updatedAt'> = {
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

function makeTestEntry(
  id: string,
  title: string,
  aliases: string[] = [],
  updatedAt = '2026-01-01T00:00:00Z',
): Entry {
  return { ...BASE_ENTRY_FIXTURE, id, title, aliases, updatedAt };
}

// ---------------------------------------------------------------------------
// Phase 48 XREF-05 — Two-phase rename-propagation save (D-08/D-09/D-10)
// ---------------------------------------------------------------------------

// Entry that has an existing title so title-change diffing works.
const RENAME_ENTRY = makeTestEntry('RENAME-ID', 'Empire', ['The Imperium'], '2026-06-20T00:00:00Z');

/**
 * Render EntryEditor in edit mode for RENAME_ENTRY.
 * apiOverrides lets tests inject custom PATCH/preview responses.
 */
function renderEditModeForRename({
  previewResponse,
  commitResponse,
}: {
  previewResponse: { affectedLinks: number; affectedEntries: number };
  commitResponse: Record<string, unknown>;
}) {
  vi.mocked(api).mockImplementation(async (path?: string, init?: RequestInit) => {
    if (!path) return undefined;
    if (path === '/universes/U1') return { entryTypes: ['place', 'character'] };
    if (path.startsWith('/universes/U1/categories')) {
      return { categories: [], uncategorizedCount: 0 };
    }
    if (path === '/universes/U1/entries' && !init?.method) {
      return [RENAME_ENTRY];
    }
    // Single entry load for edit mode
    if (path === '/universes/U1/entries/RENAME-ID' && !init?.method) {
      return {
        ...RENAME_ENTRY,
        body: '',
        outboundLinks: [],
        backlinks: [],
        issues: [],
      };
    }
    // Preview call: PATCH with ?preview=true
    if (
      path.startsWith('/universes/U1/entries/RENAME-ID') &&
      path.includes('preview=true') &&
      init?.method === 'PATCH'
    ) {
      return previewResponse;
    }
    // Commit call: PATCH without ?preview=true
    if (
      path === '/universes/U1/entries/RENAME-ID' &&
      init?.method === 'PATCH'
    ) {
      return commitResponse;
    }
    if (path === '/universes/U1/assets' && !init?.method) {
      return [];
    }
    return undefined;
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/universes/U1/entries/RENAME-ID/edit']}>
        <Routes>
          <Route path="/universes/:uid/entries/:entryId/edit" element={<EntryEditor />} />
          <Route path="/universes/:uid/entries/:entryId" element={<div>Entry detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Content-Forward Views §5 (Task 10) — editor hero
// ---------------------------------------------------------------------------

// Render EntryEditor in edit mode for a fixture entry with caller-supplied
// overrides (coverImageId / title / icon), following the file's existing
// renderEditModeForRename pattern. Editor drafts carry coverImageId only (no
// signed cover URL), so the hero's <img> src is built directly in production
// code — this fixture mirrors that (no coverImageUrl field).
function renderEditorForExistingEntry(overrides: Partial<Entry> = {}) {
  const fixtureEntry: Entry = {
    ...BASE_ENTRY_FIXTURE,
    id: 'HERO-ID',
    title: 'Existing Entry',
    aliases: [],
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };

  vi.mocked(api).mockImplementation(async (path?: string, init?: RequestInit) => {
    if (!path) return undefined;
    if (path === '/universes/U1') return { entryTypes: ['character', 'place'] };
    if (path.startsWith('/universes/U1/categories')) {
      return { categories: [], uncategorizedCount: 0 };
    }
    if (path === '/universes/U1/entries' && !init?.method) {
      return [fixtureEntry];
    }
    if (path === '/universes/U1/entries/HERO-ID' && !init?.method) {
      return { ...fixtureEntry, outboundLinks: [], backlinks: [], issues: [] };
    }
    if (path === '/universes/U1/assets' && !init?.method) {
      return [];
    }
    return undefined;
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/universes/U1/entries/HERO-ID/edit']}>
        <Routes>
          <Route path="/universes/:uid/entries/:entryId/edit" element={<EntryEditor />} />
          <Route path="/universes/:uid/entries/:entryId" element={<div>Entry detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderEditorForAuthoringPanels({
  entryOverrides = {},
  detailOverrides = {},
  entries = [],
  assets = [],
}: {
  entryOverrides?: Partial<Entry>;
  detailOverrides?: {
    body?: string;
    backlinks?: Backlink[];
    assetUrls?: Record<string, string>;
  };
  entries?: Entry[];
  assets?: AssetSummary[];
} = {}) {
  const fixtureEntry: Entry = {
    ...BASE_ENTRY_FIXTURE,
    id: 'AUTHOR-ID',
    title: 'Draft Entry',
    aliases: [],
    updatedAt: '2026-01-01T00:00:00Z',
    ...entryOverrides,
  };
  const entryList = entries.length > 0 ? entries : [fixtureEntry];

  vi.mocked(api).mockImplementation(async (path?: string, init?: RequestInit) => {
    if (!path) return undefined;
    if (path === '/universes/U1') return { entryTypes: ['character', 'place'] };
    if (path.startsWith('/universes/U1/categories')) {
      return { categories: [], uncategorizedCount: 0 };
    }
    if (path === '/universes/U1/entries' && !init?.method) {
      return entryList;
    }
    if (path === '/universes/U1/entries/AUTHOR-ID' && !init?.method) {
      return {
        ...fixtureEntry,
        body: detailOverrides.body ?? '',
        outboundLinks: [],
        backlinks: detailOverrides.backlinks ?? [],
        issues: [],
        assetUrls: detailOverrides.assetUrls ?? {},
      };
    }
    if (path === '/universes/U1/assets' && !init?.method) {
      return assets;
    }
    return undefined;
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/universes/U1/entries/AUTHOR-ID/edit']}>
        <Routes>
          <Route path="/universes/:uid/entries/:entryId/edit" element={<EntryEditor />} />
          <Route path="/universes/:uid/entries/:entryId" element={<div>Entry detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Content-Forward Views §5 — editor hero', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    document.body.style.removeProperty('pointer-events');
    document.body.removeAttribute('data-scroll-locked');
  });

  it('shows a monogram hero for a new entry, reflecting the title as you type', async () => {
    setupApi({
      universe: { entryTypes: ['character', 'place'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });
    const user = userEvent.setup();
    renderEditor(); // existing helper — new-entry mode

    await user.type(screen.getByLabelText(/title/i), 'Aldric');

    const hero = screen.getByTestId('editor-hero');
    // The hero previews what the DETAIL page will render — it must track the draft live.
    expect(within(hero).getByTestId('hero-monogram')).toHaveTextContent('A');
  });

  it('offers the cover affordance and opens the EXISTING set-cover asset picker', async () => {
    setupApi({
      universe: { entryTypes: ['character', 'place'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });
    const user = userEvent.setup();
    renderEditor();

    const hero = screen.getByTestId('editor-hero');
    await user.click(within(hero).getByRole('button', { name: /set cover image/i }));

    // AssetPickerModal is the pre-existing flow — this task only changed the trigger.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows the cover in the hero, with Change and Remove, once one is set', async () => {
    // Editor drafts carry coverImageId only (no signed URL), so the src is built directly.
    renderEditorForExistingEntry({ coverImageId: 'a1' });

    const hero = await screen.findByTestId('editor-hero');
    const img = within(hero).getByRole('img', { name: /cover/i });
    expect(img).toHaveAttribute('src', expect.stringContaining('/assets/a1/thumb'));
    expect(within(hero).getByRole('button', { name: /change cover/i })).toBeInTheDocument();
    expect(within(hero).getByRole('button', { name: /remove cover/i })).toBeInTheDocument();
  });

  it('opens the set-cover asset picker from "Change cover" too (same handler, cover-set variant)', async () => {
    const user = userEvent.setup();
    renderEditorForExistingEntry({ coverImageId: 'a1' });

    const hero = await screen.findByTestId('editor-hero');
    await user.click(within(hero).getByRole('button', { name: /change cover/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the cover affordance when the cover image fails to load (signed URLs expire)', async () => {
    // The button row is IN FLOW precisely so an onError'd image cannot collapse the hero.
    // Without that, hiding the img would leave a zero-height box and the affordance would
    // vanish — the bug the detail hero already had to fix.
    renderEditorForExistingEntry({ coverImageId: 'a1' });
    const hero = await screen.findByTestId('editor-hero');
    fireEvent.error(within(hero).getByRole('img', { name: /cover/i }));
    expect(within(hero).getByRole('button', { name: /change cover/i })).toBeInTheDocument();
  });

  it('clears the cover and falls back to the monogram band when Remove is clicked', async () => {
    const user = userEvent.setup();
    renderEditorForExistingEntry({ coverImageId: 'a1', title: 'Aldric' });

    const hero = await screen.findByTestId('editor-hero');
    await user.click(within(hero).getByRole('button', { name: /remove cover/i }));

    expect(within(hero).queryByRole('img')).not.toBeInTheDocument();
    expect(within(hero).getByTestId('hero-monogram')).toHaveTextContent('A');
  });

  it('watermarks the draft emoji rather than a letter when the entry has an icon', async () => {
    renderEditorForExistingEntry({ icon: '🜂', title: 'Aldric' });
    const hero = await screen.findByTestId('editor-hero');
    // Matches EntryDetail: the contract resolves cover → icon → monogram.
    expect(within(hero).getByTestId('hero-monogram')).toHaveTextContent('🜂');
  });
});

describe('EntryEditor authoring navigation and recovery (Task 6)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    document.body.style.removeProperty('pointer-events');
    document.body.removeAttribute('data-scroll-locked');
  });

  it('shows outline, canonical backlinks, and recovery actions wired to source/picker flow', async () => {
    const user = userEvent.setup();
    const markdown = '# Intro\n\n## Details\n\n## Details\n\n[[Glossary]]\n\n![Map](asset://lost-asset)';
    renderEditorForAuthoringPanels({
      detailOverrides: {
        body: markdown,
        backlinks: [
          {
            id: 'backlink-1',
            sourceEntryId: 'atlas-id',
            sourceTitle: 'Atlas',
            sourceIcon: '',
            label: 'mentions',
            linkType: null,
            direction: 'inbound',
          },
        ],
        assetUrls: {},
      },
      entries: [
        {
          ...BASE_ENTRY_FIXTURE,
          id: 'AUTHOR-ID',
          title: 'Draft Entry',
          aliases: [],
          updatedAt: '2026-01-01T00:00:00Z',
        },
        {
          ...BASE_ENTRY_FIXTURE,
          id: 'atlas-id',
          title: 'Atlas',
          aliases: [],
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      assets: [
        {
          id: 'asset-2',
          universeId: 'U1',
          filename: 'new-map.png',
          mimeType: 'image/png',
          extension: 'png',
          sizeBytes: 12,
          thumbSizeBytes: 8,
          altText: 'New map',
          rawUrl: 'https://example.com/raw.png',
          thumbUrl: 'https://example.com/thumb.png',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    expect(await screen.findByRole('heading', { name: /outline/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Atlas' })).toBeInTheDocument();
    expect(screen.getAllByText('[[Glossary]]').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /open in source/i })).toBeInTheDocument();

    const liveHeadings = await screen.findAllByRole('heading', { name: 'Details' });
    expect(liveHeadings[0]).toHaveAttribute('id', 'details');
    expect(liveHeadings[1]).toHaveAttribute('id', 'details-2');
    const scrollIntoView = vi.fn();
    liveHeadings[1].scrollIntoView = scrollIntoView;
    await user.click(screen.getAllByRole('button', { name: 'Details' })[1]);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.querySelector('textarea[aria-label="Entry body"]')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /open in source/i }));
    const source = await screen.findByRole('textbox', { name: 'Entry body' }) as HTMLTextAreaElement;
    expect(source.selectionStart).toBe(markdown.indexOf('[[Glossary]]'));
    expect(source.selectionEnd).toBe(markdown.indexOf('[[Glossary]]') + '[[Glossary]]'.length);

    await user.click(screen.getByRole('button', { name: /replace image/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /select new-map\.png/i }));
    await user.click(screen.getByRole('button', { name: /^insert$/i }));

    await waitFor(() => {
      expect(source.value).toContain('![Map](asset://asset-2)');
      expect(source.value).not.toContain('asset://lost-asset');
    });
  });
});

describe('EntryEditor rename-propagation two-phase save (Phase 48 XREF-05)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    document.body.style.removeProperty('pointer-events');
    document.body.removeAttribute('data-scroll-locked');
  });

  it('D-08: rename with preview affectedLinks=3 shows ConfirmDialog with link count before any commit', async () => {
    renderEditModeForRename({
      previewResponse: { affectedLinks: 3, affectedEntries: 2 },
      commitResponse: { ...RENAME_ENTRY, rewriteCount: 3 },
    });

    // Wait for the editor to load the entry
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
    await screen.findByDisplayValue('Empire');

    // Change the title to trigger propagation
    const titleInput = screen.getByLabelText(/title/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Imperium');

    // Submit the form
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // ConfirmDialog should appear with the link count
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText(/3 link/i)).toBeInTheDocument();
      expect(screen.getByText(/2 entr/i)).toBeInTheDocument();
    });

    // The Proceed button with confirmLabel should be visible
    expect(screen.getByRole('button', { name: /proceed/i })).toBeInTheDocument();

    // Verify NO commit PATCH was made yet (only the preview call)
    const patchCommitCalls = vi.mocked(api).mock.calls.filter(
      ([path, init]) =>
        typeof path === 'string' &&
        path === '/universes/U1/entries/RENAME-ID' &&
        (init as RequestInit)?.method === 'PATCH',
    );
    expect(patchCommitCalls).toHaveLength(0);
  });

  it('D-09: clicking Cancel in the ConfirmDialog makes no PATCH commit', async () => {
    renderEditModeForRename({
      previewResponse: { affectedLinks: 3, affectedEntries: 2 },
      commitResponse: { ...RENAME_ENTRY, rewriteCount: 3 },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
    await screen.findByDisplayValue('Empire');

    const titleInput = screen.getByLabelText(/title/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Imperium');

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // Wait for dialog
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Click Cancel
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // Dialog should close
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Still NO commit PATCH call was made
    const patchCommitCalls = vi.mocked(api).mock.calls.filter(
      ([path, init]) =>
        typeof path === 'string' &&
        path === '/universes/U1/entries/RENAME-ID' &&
        (init as RequestInit)?.method === 'PATCH',
    );
    expect(patchCommitCalls).toHaveLength(0);
  });

  it('D-08: rename with preview affectedLinks=0 saves silently with no dialog', async () => {
    renderEditModeForRename({
      previewResponse: { affectedLinks: 0, affectedEntries: 0 },
      commitResponse: { ...RENAME_ENTRY, title: 'Imperium', rewriteCount: 0 },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
    await screen.findByDisplayValue('Empire');

    const titleInput = screen.getByLabelText(/title/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Imperium');

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // No dialog should appear
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      },
      { timeout: 500 },
    );

    // A commit PATCH (not preview) should have fired
    await waitFor(() => {
      const patchCommitCalls = vi.mocked(api).mock.calls.filter(
        ([path, init]) =>
          typeof path === 'string' &&
          path === '/universes/U1/entries/RENAME-ID' &&
          (init as RequestInit)?.method === 'PATCH',
      );
      expect(patchCommitCalls.length).toBeGreaterThan(0);
    });
  });

  it('D-10: after Proceed, "N links rewritten" after-summary is shown via toast', async () => {
    renderEditModeForRename({
      previewResponse: { affectedLinks: 3, affectedEntries: 2 },
      commitResponse: { ...RENAME_ENTRY, title: 'Imperium', rewriteCount: 3 },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
    await screen.findByDisplayValue('Empire');

    const titleInput = screen.getByLabelText(/title/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Imperium');

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // Wait for confirm dialog
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Click Proceed
    await userEvent.click(screen.getByRole('button', { name: /proceed/i }));

    // After commit, the after-summary "3 links rewritten" should appear (D-10)
    await waitFor(() => {
      expect(screen.getByText(/3 links rewritten/i)).toBeInTheDocument();
    });
  });

  it('keeps preview and commit payload bodies as ordinary Markdown during a title rename', async () => {
    const markdown = '# Quest\n\n[[Mordor]]\n\n![map](asset://asset-1)';

    vi.mocked(api).mockImplementation(async (path?: string, init?: RequestInit) => {
      if (!path) return undefined;
      if (path === '/universes/U1') return { entryTypes: ['place', 'character'] };
      if (path.startsWith('/universes/U1/categories')) {
        return { categories: [], uncategorizedCount: 0 };
      }
      if (path === '/universes/U1/entries' && !init?.method) {
        return [RENAME_ENTRY];
      }
      if (path === '/universes/U1/entries/RENAME-ID' && !init?.method) {
        return {
          ...RENAME_ENTRY,
          body: markdown,
          outboundLinks: [],
          backlinks: [],
          issues: [],
          assetUrls: { 'asset-1': 'https://example.com/asset-1.png' },
        };
      }
      if (path === '/universes/U1/assets' && !init?.method) {
        return [];
      }
      if (
        path.startsWith('/universes/U1/entries/RENAME-ID') &&
        path.includes('preview=true') &&
        init?.method === 'PATCH'
      ) {
        return { affectedLinks: 1, affectedEntries: 1 };
      }
      if (path === '/universes/U1/entries/RENAME-ID' && init?.method === 'PATCH') {
        return { ...RENAME_ENTRY, title: 'Imperium', rewriteCount: 1 };
      }
      return undefined;
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/universes/U1/entries/RENAME-ID/edit']}>
          <Routes>
            <Route path="/universes/:uid/entries/:entryId/edit" element={<EntryEditor />} />
            <Route path="/universes/:uid/entries/:entryId" element={<div>Entry detail</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByDisplayValue('Empire');
    const titleInput = screen.getByLabelText(/title/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Imperium');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /proceed/i }));

    await waitFor(() => {
      const previewCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        typeof path === 'string' &&
        path.includes('/universes/U1/entries/RENAME-ID?preview=true') &&
        (init as RequestInit)?.method === 'PATCH',
      );
      const commitCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        path === '/universes/U1/entries/RENAME-ID' &&
        (init as RequestInit)?.method === 'PATCH',
      );
      expect(previewCall).toBeDefined();
      expect(commitCall).toBeDefined();
      expect(JSON.parse((previewCall![1] as RequestInit).body as string).body).toBe(markdown);
      expect(JSON.parse((commitCall![1] as RequestInit).body as string).body).toBe(markdown);
    });
  });
});
