import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('pre-fills entryType, body, and meta from location.state.template on mount', async () => {
    setupApi({
      universe: { entryTypes: ['location', 'character'] },
      categories: [],
      createResponse: { id: 'new-id' },
    });

    renderEditor({
      state: {
        template: {
          id: 'location',
          label: 'Location',
          entryType: 'location',
          category: 'Setting',
          body: '## Geography\n\n## Population\n',
          meta: { region: '', climate: '' },
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
          id: 'concept',
          label: 'Concept',
          entryType: 'character',
          category: 'Setting',
          body: '',
          meta: { foo: 'a' },
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
