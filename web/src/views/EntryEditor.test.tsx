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

function renderEditor() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/universes/U1/entries/new']}>
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
