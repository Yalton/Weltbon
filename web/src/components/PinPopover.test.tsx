import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({ api: vi.fn() }));
import { api } from '../api/client';
import { PinPopover, type PinPopoverProps } from './PinPopover';

function renderPopover(props?: Partial<PinPopoverProps>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = props?.onOpenChange ?? vi.fn();
  const onError = props?.onError;
  const finalProps: PinPopoverProps = {
    universeId: 'U1',
    open: true,
    onOpenChange,
    entryId: 'E1',
    dropX: 100,
    dropY: 200,
    initialPosition: 1500,
    initialLabel: 'Founding of Gondor',
    ...props,
    onError,
  };
  const utils = render(
    <QueryClientProvider client={qc}>
      <PinPopover {...finalProps} />
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange, qc };
}

describe('PinPopover', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    vi.mocked(api).mockResolvedValue(undefined as unknown as never);
  });

  it('renders title "Pin entry" when open', async () => {
    renderPopover();
    expect(
      await screen.findByRole('heading', { name: 'Pin entry' }),
    ).toBeInTheDocument();
    // Primary CTA also reads "Pin entry"
    expect(screen.getByRole('button', { name: 'Pin entry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard pin' })).toBeInTheDocument();
  });

  it('position input is prefilled with String(initialPosition)', async () => {
    renderPopover({ initialPosition: 4.35e17 });
    const input = (await screen.findByLabelText('Position')) as HTMLInputElement;
    expect(input.value).toBe(String(4.35e17));
    // type="text" — NOT type="number"
    expect(input.getAttribute('type')).toBe('text');
  });

  it('label field is present, optional, and editable', async () => {
    const user = userEvent.setup();
    renderPopover({ initialLabel: 'Initial' });
    const label = (await screen.findByLabelText('Label (optional)')) as HTMLInputElement;
    expect(label.value).toBe('Initial');
    await user.clear(label);
    await user.type(label, 'Edited');
    expect(label.value).toBe('Edited');
  });

  it('precision picker defaults to "exact"', async () => {
    renderPopover();
    const select = (await screen.findByLabelText('Precision')) as HTMLSelectElement;
    expect(select.value).toBe('exact');
  });

  it('submit with valid position posts {entryId, position, label, precision} and closes', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path === '/universes/U1/entries/E1/pin') {
        return { id: 'p1', entryId: 'E1', label: 'Founding of Gondor', position: 1500, precision: 'exact' } as unknown as never;
      }
      return undefined as unknown as never;
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();
    await user.click(await screen.findByRole('button', { name: 'Pin entry' }));

    await waitFor(() => {
      const posted = vi.mocked(api).mock.calls.find(
        ([p, init]) =>
          typeof p === 'string' &&
          p === '/universes/U1/entries/E1/pin' &&
          (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posted).toBeTruthy();
      const body = JSON.parse((posted![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        position: 1500,
        label: 'Founding of Gondor',
        precision: 'exact',
      });
    });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('submit with invalid position shows the locked inline error and does NOT POST', async () => {
    const user = userEvent.setup();
    renderPopover();
    const positionInput = (await screen.findByLabelText('Position')) as HTMLInputElement;
    await user.clear(positionInput);
    await user.type(positionInput, 'not-a-number');
    await user.click(screen.getByRole('button', { name: 'Pin entry' }));

    expect(
      await screen.findByText('Enter a valid number (e.g. 4.35e17 or -10000).'),
    ).toBeInTheDocument();
    const posts = vi.mocked(api).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('mutation rejection shows the locked inline error AND invokes onError', async () => {
    vi.mocked(api).mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') throw new Error('500 Server Error');
      return undefined as unknown as never;
    });
    const user = userEvent.setup();
    const onErrorSpy = vi.fn();
    const { onOpenChange } = renderPopover({ onError: onErrorSpy });
    await user.click(await screen.findByRole('button', { name: 'Pin entry' }));

    expect(
      await screen.findByText("Couldn't save pin. Try again."),
    ).toBeInTheDocument();
    expect(onErrorSpy).toHaveBeenCalledTimes(1);
    // Popover stays open on error (belt-and-suspenders).
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('Esc keydown closes the popover without POSTing', async () => {
    const { onOpenChange } = renderPopover();
    await screen.findByRole('heading', { name: 'Pin entry' });
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    const posts = vi.mocked(api).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('outside-click closes the popover without POSTing', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();
    await screen.findByRole('heading', { name: 'Pin entry' });
    await user.click(document.body);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    const posts = vi.mocked(api).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('Discard pin button closes the popover without POSTing', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPopover();
    await user.click(await screen.findByRole('button', { name: 'Discard pin' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const posts = vi.mocked(api).mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('renders the locked Position hint copy', async () => {
    renderPopover();
    expect(
      await screen.findByText('Adjust the exact position if needed.'),
    ).toBeInTheDocument();
  });
});
