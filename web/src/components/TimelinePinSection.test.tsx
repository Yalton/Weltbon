import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { TimelinePinSection } from './TimelinePinSection';
import type { TimelinePin } from '../hooks/useTimelinePins';

function renderSection(props: Parameters<typeof TimelinePinSection>[0]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TimelinePinSection {...props} />
    </QueryClientProvider>,
  );
}

const PIN_E1: TimelinePin = {
  id: 'p1',
  entryId: 'E1',
  label: 'Founding of Gondor',
  position: 3320,
  precision: 'approximate',
};

describe('TimelinePinSection', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders Not pinned + Add pin button when no matching pin', async () => {
    vi.mocked(api).mockResolvedValue([]);
    renderSection({ universeId: 'U1', entryId: 'E1' });

    expect(await screen.findByText(/not pinned/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add pin/i })).toBeInTheDocument();
  });

  it('renders Not pinned when timeline has pins for other entries only', async () => {
    vi.mocked(api).mockResolvedValue([
      { ...PIN_E1, id: 'p2', entryId: 'OTHER' },
    ]);
    renderSection({ universeId: 'U1', entryId: 'E1' });

    expect(await screen.findByText(/not pinned/i)).toBeInTheDocument();
  });

  it('renders pin label, position, precision badge + Edit/Remove when matching pin exists', async () => {
    vi.mocked(api).mockResolvedValue([PIN_E1]);
    renderSection({ universeId: 'U1', entryId: 'E1' });

    expect(await screen.findByText('Founding of Gondor')).toBeInTheDocument();
    expect(screen.getByText('3320')).toBeInTheDocument();
    expect(screen.getByText(/approximate/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument();
  });

  it('clicking Add pin opens PinEditor dialog', async () => {
    vi.mocked(api).mockResolvedValue([]);
    renderSection({ universeId: 'U1', entryId: 'E1' });

    await userEvent.click(await screen.findByRole('button', { name: /add pin/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /pin to timeline/i })).toBeInTheDocument();
  });

  it('clicking Edit opens PinEditor pre-filled with current pin values', async () => {
    vi.mocked(api).mockResolvedValue([PIN_E1]);
    renderSection({ universeId: 'U1', entryId: 'E1' });

    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /edit pin/i })).toBeInTheDocument();

    const labelInput = screen.getByLabelText(/^label$/i) as HTMLInputElement;
    const positionInput = screen.getByLabelText(/^position$/i) as HTMLInputElement;
    expect(labelInput.value).toBe('Founding of Gondor');
    expect(positionInput.value).toBe('3320');
  });

  it('clicking Remove opens ConfirmDialog', async () => {
    vi.mocked(api).mockResolvedValue([PIN_E1]);
    renderSection({ universeId: 'U1', entryId: 'E1' });

    await userEvent.click(await screen.findByRole('button', { name: /remove/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /remove pin/i })).toBeInTheDocument();
  });

  it('confirming Remove calls DELETE mutation', async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === '/universes/U1/timeline') return [PIN_E1];
      if (init?.method === 'DELETE') return undefined;
      return undefined;
    });
    renderSection({ universeId: 'U1', entryId: 'E1' });

    await userEvent.click(await screen.findByRole('button', { name: /remove/i }));
    await screen.findByRole('dialog');
    // Confirm button is the destructive Remove inside the dialog (last "Remove" rendered)
    const removeButtons = screen.getAllByRole('button', { name: /^remove$/i });
    await userEvent.click(removeButtons[removeButtons.length - 1]);

    await waitFor(() => {
      const deleteCall = vi.mocked(api).mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0] === '/universes/U1/entries/E1/pin' &&
          (c[1] as RequestInit)?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it('PinEditor submit with valid position calls upsert mutation', async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === '/universes/U1/timeline') return [];
      if (init?.method === 'POST') {
        return {
          id: 'p9',
          entryId: 'E1',
          label: 'New pin',
          position: 1000,
          precision: 'exact',
        };
      }
      return undefined;
    });
    renderSection({ universeId: 'U1', entryId: 'E1' });

    await userEvent.click(await screen.findByRole('button', { name: /add pin/i }));
    await screen.findByRole('dialog');

    await userEvent.type(screen.getByLabelText(/^label$/i), 'New pin');
    await userEvent.type(screen.getByLabelText(/^position$/i), '1000');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const postCall = vi.mocked(api).mock.calls.find(
        (c) =>
          typeof c[0] === 'string' &&
          c[0] === '/universes/U1/entries/E1/pin' &&
          (c[1] as RequestInit)?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(String((postCall![1] as RequestInit).body));
      expect(body).toMatchObject({ label: 'New pin', position: 1000 });
    });
  });

  it('PinEditor submit with invalid position shows error and does NOT call mutation', async () => {
    vi.mocked(api).mockResolvedValue([]);
    renderSection({ universeId: 'U1', entryId: 'E1' });

    await userEvent.click(await screen.findByRole('button', { name: /add pin/i }));
    await screen.findByRole('dialog');

    await userEvent.type(screen.getByLabelText(/^label$/i), 'Bad pin');
    await userEvent.type(screen.getByLabelText(/^position$/i), 'abc');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/must be a finite number/i)).toBeInTheDocument();

    const postCall = vi.mocked(api).mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });
});
