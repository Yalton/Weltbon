import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { LinkEditor } from './LinkEditor';

function renderEditor(
  universeId = 'U1',
  entryId = 'E1',
  editLink?: { id: string; label: string | null; linkType: string | null; direction: string },
) {
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
        editLink={editLink}
      >
        <button type="button">Open link editor</button>
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

function setupApiMock(opts: { onCreate?: (body: unknown) => void; onPatch?: (path: string, body: unknown) => void; failCreate?: boolean } = {}) {
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    if (opts.failCreate && path.includes('/links') && init?.method === 'POST') {
      throw new Error('Bad Request');
    }
    if (path.includes('/entries') && (!init || (init.method ?? 'GET') === 'GET')) {
      return ENTRIES as unknown as never;
    }
    if (path.includes('/relations')) {
      return RELATIONS as unknown as never;
    }
    if (path.includes('/link-types')) {
      return [] as unknown as never;
    }
    if (path.includes('/links') && init?.method === 'POST') {
      opts.onCreate?.(JSON.parse(String(init.body)));
      return {
        id: 'L1',
        universeId: 'U1',
        sourceEntryId: 'E1',
        targetEntryId: 'E2',
        label: 'created by',
        linkType: null,
        direction: 'directed',
        createdAt: '',
      } as unknown as never;
    }
    if (path.includes('/links/') && init?.method === 'PATCH') {
      opts.onPatch?.(path, JSON.parse(String(init.body)));
      return {} as never;
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

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'ara');

    expect(await screen.findByText('Aragorn')).toBeInTheDocument();
    expect(screen.queryByText('Boromir')).toBeNull();
  });

  it('renders the display label field as a RelationCombobox (role=combobox placeholder=sworn shield)', async () => {
    setupApiMock();
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    // The display-label RelationCombobox has the "sworn shield" placeholder
    const labelCombobox = await screen.findByPlaceholderText(/sworn shield/i);
    expect(labelCombobox).toHaveAttribute('role', 'combobox');
  });

  it('renders the link-type selector with combobox role', async () => {
    setupApiMock();
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    // LinkTypeSelect has placeholder "Search or enter a type..."
    const typeCombobox = await screen.findByPlaceholderText(/search or enter a type/i);
    expect(typeCombobox).toHaveAttribute('role', 'combobox');
  });

  it('clicking a relation suggestion + Add link calls useCreateLink with that label', async () => {
    let createdBody: { label?: string | null } | null = null;
    setupApiMock({ onCreate: (b) => { createdBody = b as { label?: string | null }; } });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    // Type into the display-label combobox ("sworn shield" placeholder)
    const labelCombobox = screen.getByPlaceholderText(/sworn shield/i);
    await user.click(labelCombobox);
    await user.click(await screen.findByText('created by'));

    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      expect(createdBody).not.toBeNull();
    });
    expect(createdBody!.label).toBe('created by');
  });

  // #29 regression. Every test above asserts a SUCCESSFUL create, so a rejected
  // mutation was never exercised — and handleSubmit had no try/catch, so the
  // throw aborted before setOpen(false) and the popover simply sat there. That
  // is why the #28 400 presented to users as a dead button rather than an error.
  it('surfaces an error and keeps the popover open when the create fails', async () => {
    setupApiMock({ failCreate: true });
    const user = userEvent.setup();
    const { onLinkCreated } = renderEditor();

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));
    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    // The user must be told the create failed.
    expect(await screen.findByText(/couldn't create link/i)).toBeInTheDocument();
    // And must not lose the target they already picked, so retry is one click.
    expect(screen.getByRole('button', { name: /^add link$/i })).toBeInTheDocument();
    expect(onLinkCreated).not.toHaveBeenCalled();
  });

  it('free-entry: typing a novel label + Add link still submits the typed string', async () => {
    let createdBody: { label?: string | null } | null = null;
    setupApiMock({ onCreate: (b) => { createdBody = b as typeof createdBody; } });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    const labelCombobox = screen.getByPlaceholderText(/sworn shield/i);
    await user.click(labelCombobox);
    await user.type(labelCombobox, 'invented label');
    await user.keyboard('{Enter}');

    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      expect(createdBody).not.toBeNull();
    });
    expect(createdBody!.label).toBe('invented label');
  });

  it('direction toggle flows into the create payload', async () => {
    let createdBody: { direction?: string; label?: string | null } | null = null;
    setupApiMock({ onCreate: (b) => { createdBody = b as typeof createdBody; } });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    // Find direction buttons via the group; second button is undirected (A ↔ B)
    const directionGroup = await screen.findByRole('group', { name: /direction/i });
    const buttons = directionGroup.querySelectorAll('button');
    // Second button is undirected (A ↔ B)
    await user.click(buttons[1]);

    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      expect(createdBody).not.toBeNull();
    });
    expect(createdBody!.direction).toBe('undirected');
  });

  it('invalidates the relations cache after a successful create', async () => {
    setupApiMock();
    const user = userEvent.setup();
    const { qc } = renderEditor();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    // Click Add link — no label required (canSubmit = target only)
    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      const invalidated = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] })?.queryKey?.[0]);
      expect(invalidated).toContain('relations');
    });
  });

  it('canSubmit requires only a target entry — no label needed', async () => {
    let createdBody: unknown = null;
    setupApiMock({ onCreate: (b) => { createdBody = b; } });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    const search = await screen.findByPlaceholderText(/search entries/i);
    await user.type(search, 'Aragorn');
    await user.click(await screen.findByText('Aragorn'));

    // Click Add link without any label — should succeed
    await user.click(screen.getByRole('button', { name: /^add link$/i }));

    await waitFor(() => {
      expect(createdBody).not.toBeNull();
    });
    expect((createdBody as { label?: unknown }).label).toBeNull();
  });

  it('edits existing link fields and sends their changed values to its PATCH endpoint', async () => {
    let patchedBody: { label?: string | null; linkType?: string | null; direction?: string } | null = null;
    let patchedPath = '';
    setupApiMock({ onPatch: (path, body) => {
      patchedPath = path;
      patchedBody = body as typeof patchedBody;
    } });
    const user = userEvent.setup();
    const { onLinkCreated, qc } = renderEditor('U1', 'E1', {
      id: 'L1', label: 'created by', linkType: 'parent', direction: 'undirected',
    });

    await user.click(screen.getByRole('button', { name: /open link editor/i }));
    expect(screen.queryByPlaceholderText(/search entries/i)).toBeNull();
    expect(screen.getByPlaceholderText(/sworn shield/i)).toHaveValue('created by');
    expect(screen.getByRole('button', { name: /^save changes$/i })).toBeInTheDocument();

    const labelInput = screen.getByPlaceholderText(/sworn shield/i);
    await user.clear(labelInput);
    await user.type(labelInput, 'foster parent');
    const typeInput = screen.getByPlaceholderText(/search or enter a type/i);
    await user.clear(typeInput);
    await user.type(typeInput, 'guardian');
    await user.click(screen.getByRole('button', { name: /a → b/i }));
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: /^save changes$/i }));
    await waitFor(() => expect(patchedBody).not.toBeNull());
    expect(patchedPath).toBe('/universes/U1/links/L1');
    expect(patchedBody).toEqual({ label: 'foster parent', linkType: 'guardian', direction: 'directed' });
    expect(onLinkCreated).toHaveBeenCalledOnce();
    const invalidated = invalidateSpy.mock.calls
      .map((call) => (call[0] as { queryKey?: unknown[] })?.queryKey?.[0]);
    expect(invalidated).toEqual(expect.arrayContaining(['entry', 'graph-data', 'relations', 'link-types']));
  });
});
