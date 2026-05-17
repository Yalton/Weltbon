import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({ api: vi.fn() }));
import { api } from '../api/client';
import { CreateLinkPopover, type CreateLinkPopoverProps } from './CreateLinkPopover';
import type { GraphNode } from '../hooks/useGraphData';

const fromNode: GraphNode = {
  id: 'A',
  title: 'Alpha',
  entryType: 'character',
  summary: '',
  icon: '',
};

const toNode: GraphNode = {
  id: 'B',
  title: 'Beta',
  entryType: 'location',
  summary: '',
  icon: '',
};

const linkRecord = {
  id: 'L1',
  universeId: 'U1',
  sourceEntryId: 'A',
  targetEntryId: 'B',
  label: 'knows',
  bidirectional: false,
  createdAt: '2026-05-16T00:00:00Z',
};

function renderPopover(props?: Partial<CreateLinkPopoverProps>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = props?.onOpenChange ?? vi.fn();
  const onError = props?.onError;
  const finalProps: CreateLinkPopoverProps = {
    universeId: 'U1',
    open: true,
    onOpenChange,
    from: fromNode,
    to: toNode,
    dropX: 100,
    dropY: 200,
    ...props,
    onError,
  };
  const utils = render(
    <QueryClientProvider client={qc}>
      <CreateLinkPopover {...finalProps} />
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange, qc };
}

describe('CreateLinkPopover', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    // Default: useRelations call returns empty array so the combobox renders cleanly.
    vi.mocked(api).mockResolvedValue([] as unknown as never);
  });

  it('renders title, From/To header, and placeholder text (GRAPH-03)', async () => {
    renderPopover();

    // Title heading + button both render "Create link" verbatim (UI-SPEC §E)
    expect(await screen.findByRole('heading', { name: 'Create link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();

    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input).toHaveAttribute('placeholder', 'Relation label (optional)');
  });

  it('renders RelationCombobox inside the popover content (GRAPH-03)', async () => {
    renderPopover();
    expect(await screen.findByRole('combobox')).toBeInTheDocument();
  });

  it('clicking Create posts to /universes/:uid/links and closes on success (GRAPH-04)', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return [] as unknown as never;
      }
      if (init.method === 'POST' && path.endsWith('/universes/U1/links')) {
        return linkRecord as unknown as never;
      }
      return undefined as unknown as never;
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();

    const input = await screen.findByRole('combobox');
    await user.click(input);
    await user.type(input, 'knows');

    const createBtn = screen.getByRole('button', { name: 'Create link' });
    await user.click(createBtn);

    await waitFor(() => {
      const posted = vi.mocked(api).mock.calls.find(
        ([p, init]) =>
          typeof p === 'string' &&
          p.endsWith('/universes/U1/links') &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posted).toBeTruthy();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        sourceEntryId: 'A',
        targetEntryId: 'B',
        label: 'knows',
      });
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('existingLabelHint becomes the initial label value (D-03d)', async () => {
    renderPopover({ existingLabelHint: 'rival of' });
    const input = (await screen.findByRole('combobox')) as HTMLInputElement;
    expect(input.value).toBe('rival of');
  });

  it('renders inline error and fires onError on POST failure (GRAPH-04 + UI-SPEC §H)', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return [] as unknown as never;
      }
      if (init.method === 'POST') {
        throw new Error('400 Bad Request');
      }
      return undefined as unknown as never;
    });
    const user = userEvent.setup();
    const onErrorSpy = vi.fn();
    const { onOpenChange } = renderPopover({ onError: onErrorSpy });

    const input = await screen.findByRole('combobox');
    await user.click(input);
    await user.type(input, 'invalid');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(
      await screen.findByText("Couldn't create link. Try again."),
    ).toBeInTheDocument();
    expect(onErrorSpy).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('Esc keydown closes the popover and does NOT POST', async () => {
    const { onOpenChange } = renderPopover();

    await screen.findByRole('heading', { name: 'Create link' });
    // Radix DismissableLayer listens on document at capture phase
    // (react-use-escape-keydown). fireEvent.keyDown on document is the
    // canonical jsdom path to trigger the outer popover's dismissal.
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    const posts = vi.mocked(api).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('outside-click closes the popover and does NOT POST', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();

    await screen.findByRole('heading', { name: 'Create link' });
    await user.click(document.body);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    const posts = vi.mocked(api).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('Create button shows "Creating..." and is disabled while POST is pending', async () => {
    let resolveApi: (value: unknown) => void = () => {};
    vi.mocked(api).mockImplementation((path: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return Promise.resolve([] as unknown as never);
      }
      if (init.method === 'POST') {
        return new Promise<never>((r) => {
          resolveApi = r as (value: unknown) => void;
        });
      }
      return Promise.resolve(undefined as unknown as never);
    });
    const user = userEvent.setup();
    renderPopover();

    const input = await screen.findByRole('combobox');
    await user.click(input);
    await user.type(input, 'pending');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    const creatingBtn = await screen.findByRole('button', { name: 'Creating...' });
    expect(creatingBtn).toBeDisabled();

    resolveApi(linkRecord);
  });

  it('Cancel button closes the popover and does NOT POST', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    const posts = vi.mocked(api).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });
});
