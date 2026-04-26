import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { LinkEditor } from './LinkEditor';

function renderEditor(universeId = 'U1', entryId = 'E1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onLinkCreated = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <LinkEditor
        universeId={universeId}
        entryId={entryId}
        onLinkCreated={onLinkCreated}
      >
        <button type="button">Add link</button>
      </LinkEditor>
    </QueryClientProvider>
  );
  return { ...utils, qc, onLinkCreated };
}

const ENTRIES = [
  { id: 'E2', universeId: 'U1', title: 'Aragorn', entryType: 'character', icon: '⚔️', tags: [], meta: {}, createdAt: '', updatedAt: '' },
  { id: 'E3', universeId: 'U1', title: 'Boromir', entryType: 'character', icon: null, tags: [], meta: {}, createdAt: '', updatedAt: '' },
];

const RELATIONS = [
  { label: 'created by', count: 17 },
  { label: 'allies of', count: 9 },
];

function setupApiMock(opts: { onCreate?: (body: unknown) => void } = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.includes('/entries') && (!init || (init.method ?? 'GET') === 'GET')) {
      return ENTRIES as unknown as never;
    }
    if (path.includes('/relations')) {
      return RELATIONS as unknown as never;
    }
    if (path.includes('/links') && init?.method === 'POST') {
      opts.onCreate?.(JSON.parse(String(init.body)));
      return {
        id: 'L1',
        universeId: 'U1',
        sourceEntryId: 'E1',
        targetEntryId: 'E2',
        label: 'created by',
        bidirectional: false,
        createdAt: '',
      } as unknown as never;
    }
    return null as unknown as never;
  });
}

describe('LinkEditor', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('preserves the existing entry-search behavior (regression)', async () => {
    setupApiMock();
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /add link/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'ara');

    expect(await screen.findByText('Aragorn')).toBeInTheDocument();
    expect(screen.queryByText('Boromir')).toBeNull();
  });

  it('renders the relation field as a RelationCombobox (role=combobox)', async () => {
    setupApiMock();
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /add link/i }));
    const combobox = await screen.findByRole('combobox');
    expect(combobox).toHaveAttribute('placeholder', expect.stringMatching(/created by/i));
  });

  it('clicking a relation suggestion + Add link calls useCreateLink with that label', async () => {
    let createdBody: { label?: string } | null = null;
    setupApiMock({ onCreate: (b) => { createdBody = b as { label?: string }; } });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /add link/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    const combobox = screen.getByRole('combobox');
    await user.click(combobox);
    await user.click(await screen.findByText('created by'));

    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      expect(createdBody).not.toBeNull();
    });
    expect(createdBody!.label).toBe('created by');
  });

  it('free-entry: typing a novel label + Add link still submits the typed string', async () => {
    let createdBody: { label?: string; bidirectional?: boolean } | null = null;
    setupApiMock({ onCreate: (b) => { createdBody = b as typeof createdBody; } });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /add link/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    const combobox = screen.getByRole('combobox');
    await user.click(combobox);
    await user.type(combobox, 'invented label');
    await user.keyboard('{Enter}');

    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      expect(createdBody).not.toBeNull();
    });
    expect(createdBody!.label).toBe('invented label');
  });

  it('bidirectional checkbox state flows into the create payload', async () => {
    let createdBody: { bidirectional?: boolean; label?: string } | null = null;
    setupApiMock({ onCreate: (b) => { createdBody = b as typeof createdBody; } });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /add link/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    const combobox = screen.getByRole('combobox');
    await user.click(combobox);
    await user.type(combobox, 'companion');
    await user.keyboard('{Enter}');

    const bidir = screen.getByRole('checkbox');
    await user.click(bidir);

    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      expect(createdBody).not.toBeNull();
    });
    expect(createdBody!.bidirectional).toBe(true);
  });

  it('invalidates the relations cache after a successful create', async () => {
    setupApiMock();
    const user = userEvent.setup();
    const { qc } = renderEditor();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await user.click(screen.getByRole('button', { name: /add link/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    const combobox = screen.getByRole('combobox');
    await user.click(combobox);
    await user.click(await screen.findByText('created by'));

    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      const invalidated = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] })?.queryKey?.[0]);
      expect(invalidated).toContain('relations');
    });
  });
});
