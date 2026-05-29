import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
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

    const bodyTextarea = (await screen.findByLabelText(/body/i)) as HTMLTextAreaElement;
    expect(bodyTextarea.value).toContain('## Geography');

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
    vi.mocked(api).mockImplementation(async (path?: string) => {
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
