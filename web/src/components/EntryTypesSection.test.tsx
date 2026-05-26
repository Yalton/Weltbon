import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    api: vi.fn(),
  };
});
import { api, ApiError } from '../api/client';
import { EntryTypesSection } from './EntryTypesSection';
import type { Universe } from '../hooks/useUniverse';

const UNIVERSE: Universe = {
  id: 'U1',
  userId: 'user-1',
  name: 'Middle Earth',
  description: '',
  entryTypes: ['concept', 'entity', 'location'],
  timelineWindow: null,
  createdAt: '',
  updatedAt: '',
  // Phase 26 LLMUI-08: audit opt-in fields default to disabled/null.
  auditEnabled: false,
  auditProvider: null,
  auditModel: null,
};

function renderSection(universe: Universe = UNIVERSE) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EntryTypesSection universe={universe} />
    </QueryClientProvider>
  );
}

describe('EntryTypesSection', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('renders one chip per universe.entryTypes value', () => {
    renderSection();
    expect(screen.getByText('concept')).toBeInTheDocument();
    expect(screen.getByText('entity')).toBeInTheDocument();
    expect(screen.getByText('location')).toBeInTheDocument();
  });

  it('Add type input + Enter calls PATCH with {action:"add", name}', async () => {
    vi.mocked(api).mockResolvedValue({ ...UNIVERSE, entryTypes: [...UNIVERSE.entryTypes, 'mythos'] });
    const user = userEvent.setup();
    renderSection();

    const input = screen.getByPlaceholderText(/add type/i);
    await user.type(input, 'mythos{Enter}');

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalled();
    });
    const [path, init] = vi.mocked(api).mock.calls[0];
    expect(path).toBe('/universes/U1/entry-types');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'add', name: 'mythos' });
  });

  it('Add 409 surfaces inline "Type already exists" error', async () => {
    vi.mocked(api).mockRejectedValueOnce(
      new ApiError(409, { error: 'duplicate_type' }, 'duplicate_type')
    );
    const user = userEvent.setup();
    renderSection();

    const input = screen.getByPlaceholderText(/add type/i);
    await user.type(input, 'concept{Enter}');

    expect(await screen.findByText(/type already exists/i)).toBeInTheDocument();
  });

  it('removing a chip with 0 entries calls DELETE without fallback (after confirm)', async () => {
    vi.mocked(api).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSection();

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    await user.click(removeButtons[0]); // remove 'concept'

    // ConfirmDialog opens — click Confirm/Delete
    const confirm = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(confirm);

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalled();
    });
    const [path, init] = vi.mocked(api).mock.calls[0];
    expect(path).toBe('/universes/U1/entry-types/concept');
    expect(init?.method).toBe('DELETE');
  });

  it('removing a chip with >0 entries opens TypeDeleteDialog with fallback select', async () => {
    vi.mocked(api).mockRejectedValueOnce(
      new ApiError(409, { error: 'entries_using_type', count: 5, type: 'concept' }, 'entries_using_type')
    );
    const user = userEvent.setup();
    renderSection();

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    await user.click(removeButtons[0]); // 'concept'

    // ConfirmDialog → Delete → 409 → fallback dialog
    const confirm = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(confirm);

    // Fallback dialog shows count + a select
    expect(await screen.findByText(/5 entr/i)).toBeInTheDocument();
    const selectEl = screen.getByRole('combobox');
    // Options should NOT include the type being deleted
    const options = Array.from(selectEl.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).not.toContain('concept');
    expect(options).toContain('entity');
    expect(options).toContain('location');
  });

  it('picking fallback + Confirm calls DELETE ?fallback=name', async () => {
    vi.mocked(api)
      .mockRejectedValueOnce(
        new ApiError(409, { error: 'entries_using_type', count: 5, type: 'concept' }, 'entries_using_type')
      )
      .mockResolvedValueOnce(undefined); // fallback DELETE succeeds
    const user = userEvent.setup();
    renderSection();

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    await user.click(removeButtons[0]);
    const confirm = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(confirm);

    const select = await screen.findByRole('combobox');
    await user.selectOptions(select, 'entity');
    const reassign = await screen.findByRole('button', { name: /delete and reassign/i });
    await user.click(reassign);

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
    });
    const [path, init] = vi.mocked(api).mock.calls[1];
    expect(path).toBe('/universes/U1/entry-types/concept?fallback=entity');
    expect(init?.method).toBe('DELETE');
  });

  it('inline rename triggers PATCH with {action:"rename", oldName, newName}', async () => {
    vi.mocked(api).mockResolvedValue({ ...UNIVERSE, entryTypes: ['idea', 'entity', 'location'] });
    const user = userEvent.setup();
    renderSection();

    const renameButtons = screen.getAllByRole('button', { name: /rename/i });
    await user.click(renameButtons[0]); // start renaming 'concept'

    const input = await screen.findByDisplayValue('concept');
    await user.clear(input);
    await user.type(input, 'idea{Enter}');

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalled();
    });
    const [path, init] = vi.mocked(api).mock.calls[0];
    expect(path).toBe('/universes/U1/entry-types');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({
      action: 'rename',
      oldName: 'concept',
      newName: 'idea',
    });
  });
});
