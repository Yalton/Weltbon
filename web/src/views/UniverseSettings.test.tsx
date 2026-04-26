import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, api: vi.fn() };
});
import { api, ApiError } from '../api/client';
import { UniverseSettings } from './UniverseSettings';

const UNIVERSE = {
  id: 'U1',
  userId: 'user-1',
  name: 'Middle Earth',
  description: 'Tolkien legendarium',
  entryTypes: ['concept', 'entity', 'location'],
  createdAt: '',
  updatedAt: '',
};

function renderSettings() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/U1/settings`]}>
        <Routes>
          <Route path="/universes/:id/settings" element={<UniverseSettings />} />
          <Route path="/universes" element={<p>Universes home</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('UniverseSettings — name + description (regression)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('renders the name and description fields with current values', async () => {
    vi.mocked(api).mockResolvedValueOnce(UNIVERSE as never);
    renderSettings();

    expect(await screen.findByDisplayValue('Middle Earth')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Tolkien legendarium')).toBeInTheDocument();
  });

  it('Save button calls PATCH /universes/:id with the changed fields', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/universes/U1' && (!init || (init.method ?? 'GET') === 'GET')) {
        return UNIVERSE as never;
      }
      if (path === '/universes/U1' && init?.method === 'PATCH') {
        return { ...UNIVERSE, name: 'New Name' } as never;
      }
      return null as never;
    });
    const user = userEvent.setup();
    renderSettings();

    const nameInput = await screen.findByDisplayValue('Middle Earth');
    await user.clear(nameInput);
    await user.type(nameInput, 'New Name');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const patches = vi.mocked(api).mock.calls.filter(
        (c) => c[0] === '/universes/U1' && c[1]?.method === 'PATCH'
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String(patches[0][1]?.body))).toEqual({ name: 'New Name' });
    });
  });
});

describe('UniverseSettings — EntryTypesSection integration', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('renders entry-type chips from the universe', async () => {
    vi.mocked(api).mockResolvedValue(UNIVERSE as never);
    renderSettings();

    expect(await screen.findByText(/^entry types$/i)).toBeInTheDocument();
    expect(screen.getByText('concept')).toBeInTheDocument();
    expect(screen.getByText('entity')).toBeInTheDocument();
    expect(screen.getByText('location')).toBeInTheDocument();
  });

  it('adding a new type via Enter calls PATCH /entry-types with action=add', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/universes/U1' && (!init || (init.method ?? 'GET') === 'GET')) {
        return UNIVERSE as never;
      }
      if (path === '/universes/U1/entry-types' && init?.method === 'PATCH') {
        return { ...UNIVERSE, entryTypes: [...UNIVERSE.entryTypes, 'mythos'] } as never;
      }
      return null as never;
    });
    const user = userEvent.setup();
    renderSettings();

    const input = await screen.findByPlaceholderText(/add type/i);
    await user.type(input, 'mythos{Enter}');

    await waitFor(() => {
      const patches = vi.mocked(api).mock.calls.filter(
        (c) => c[0] === '/universes/U1/entry-types' && c[1]?.method === 'PATCH'
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String(patches[0][1]?.body))).toEqual({ action: 'add', name: 'mythos' });
    });
  });

  it('removing a chip with 0 entries → ConfirmDialog → DELETE without fallback', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/universes/U1' && (!init || (init.method ?? 'GET') === 'GET')) {
        return UNIVERSE as never;
      }
      if (path.startsWith('/universes/U1/entry-types/concept') && init?.method === 'DELETE') {
        return undefined as never;
      }
      return null as never;
    });
    const user = userEvent.setup();
    renderSettings();

    const removeBtn = await screen.findByRole('button', { name: /remove concept/i });
    await user.click(removeBtn);

    const confirm = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(confirm);

    await waitFor(() => {
      const deletes = vi.mocked(api).mock.calls.filter(
        (c) => c[1]?.method === 'DELETE'
      );
      expect(deletes).toHaveLength(1);
      expect(deletes[0][0]).toBe('/universes/U1/entry-types/concept');
    });
  });

  it('removing a chip with >0 entries → 409 → TypeDeleteDialog → DELETE ?fallback=…', async () => {
    let firstDelete = true;
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/universes/U1' && (!init || (init.method ?? 'GET') === 'GET')) {
        return UNIVERSE as never;
      }
      if (path.startsWith('/universes/U1/entry-types/concept') && init?.method === 'DELETE') {
        if (firstDelete && !path.includes('fallback=')) {
          firstDelete = false;
          throw new ApiError(409, { error: 'entries_using_type', count: 3, type: 'concept' }, 'entries_using_type');
        }
        return undefined as never;
      }
      return null as never;
    });
    const user = userEvent.setup();
    renderSettings();

    const removeBtn = await screen.findByRole('button', { name: /remove concept/i });
    await user.click(removeBtn);
    const confirm = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(confirm);

    // TypeDeleteDialog opens
    expect(await screen.findByText(/3 entr/i)).toBeInTheDocument();
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'entity');
    await user.click(screen.getByRole('button', { name: /delete and reassign/i }));

    await waitFor(() => {
      const deletes = vi.mocked(api).mock.calls.filter(
        (c) => c[1]?.method === 'DELETE'
      );
      expect(deletes.length).toBeGreaterThanOrEqual(2);
      const last = deletes[deletes.length - 1];
      expect(last[0]).toBe('/universes/U1/entry-types/concept?fallback=entity');
    });
  });

  it('inline rename triggers PATCH action=rename', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/universes/U1' && (!init || (init.method ?? 'GET') === 'GET')) {
        return UNIVERSE as never;
      }
      if (path === '/universes/U1/entry-types' && init?.method === 'PATCH') {
        return { ...UNIVERSE, entryTypes: ['idea', 'entity', 'location'] } as never;
      }
      return null as never;
    });
    const user = userEvent.setup();
    renderSettings();

    const renameBtn = await screen.findByRole('button', { name: /rename concept/i });
    await user.click(renameBtn);

    const input = await screen.findByDisplayValue('concept');
    await user.clear(input);
    await user.type(input, 'idea{Enter}');

    await waitFor(() => {
      const patches = vi.mocked(api).mock.calls.filter(
        (c) => c[0] === '/universes/U1/entry-types' && c[1]?.method === 'PATCH'
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String(patches[0][1]?.body))).toEqual({
        action: 'rename',
        oldName: 'concept',
        newName: 'idea',
      });
    });
  });
});
