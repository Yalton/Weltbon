import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the hook BEFORE importing the component under test.
const setWindow = vi.fn();
vi.mock('../hooks/useTimelineWindow', () => ({
  useTimelineWindow: () => ({
    window: null,
    setWindow,
    isLoading: false,
    isPending: false,
  }),
}));

import { TimelineRangeDialog } from './TimelineRangeDialog';

function renderDialog(props: Partial<Parameters<typeof TimelineRangeDialog>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TimelineRangeDialog
        open={true}
        onOpenChange={vi.fn()}
        universeId="universe-1"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe('TimelineRangeDialog', () => {
  beforeEach(() => {
    setWindow.mockReset();
  });

  it('renders the locked title "Configure timeline range"', () => {
    renderDialog();
    expect(screen.getByText('Configure timeline range')).toBeInTheDocument();
  });

  it('renders a conventional close control that dismisses without saving', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onOpenChange });

    await user.clear(screen.getByLabelText(/start position/i));
    await user.type(screen.getByLabelText(/start position/i), '42');
    const close = screen.getByRole('button', {
      name: 'Close timeline settings',
    });
    expect(close).toHaveTextContent('×');
    expect(close).toHaveAttribute('title', 'Close without saving');
    await user.click(close);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(setWindow).not.toHaveBeenCalled();
  });

  it('Escape dismisses without saving', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onOpenChange });

    await user.clear(screen.getByLabelText(/end position/i));
    await user.type(screen.getByLabelText(/end position/i), '2000');
    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(setWindow).not.toHaveBeenCalled();
  });

  // #31: the fields used to open blank behind a `4.35e17` placeholder, which
  // read as a recommended end year rather than a notation example. With no
  // persisted window there is nothing to derive a range from — entries carry no
  // date — so open on a usable span the user can accept or edit.
  it('prefills a usable range when no window is configured yet', () => {
    renderDialog();
    expect(screen.getByLabelText(/start position/i)).toHaveValue('0');
    expect(screen.getByLabelText(/end position/i)).toHaveValue('1000');
  });

  it('does not offer 4.35e17 as a suggested value', () => {
    renderDialog();
    expect(screen.queryByPlaceholderText(/4\.35e17/)).not.toBeInTheDocument();
  });

  it('shows inline error "Enter a valid number ..." when submitting empty inputs', async () => {
    const user = userEvent.setup();
    renderDialog();
    // The fields now open prefilled (#31), so reaching the empty case means
    // clearing them first — this asserts validation, not the initial state.
    await user.clear(screen.getByLabelText(/start position/i));
    await user.clear(screen.getByLabelText(/end position/i));
    const saveBtn = screen.getByRole('button', { name: /^save range$/i });
    await user.click(saveBtn);
    expect(
      screen.getByText('Enter a valid number (e.g. -10000 or 4.35e17).'),
    ).toBeInTheDocument();
    expect(setWindow).not.toHaveBeenCalled();
  });

  it('shows inline error "Start must be less than end." when start >= end', async () => {
    const user = userEvent.setup();
    renderDialog();
    const startInput = screen.getByLabelText(/start position/i);
    const endInput = screen.getByLabelText(/end position/i);
    await user.clear(startInput);
    await user.type(startInput, '200');
    await user.clear(endInput);
    await user.type(endInput, '100');
    const saveBtn = screen.getByRole('button', { name: /^save range$/i });
    await user.click(saveBtn);
    expect(
      screen.getByText('Start must be less than end.'),
    ).toBeInTheDocument();
    expect(setWindow).not.toHaveBeenCalled();
  });

  it('submits valid scientific notation and closes the dialog', async () => {
    const onOpenChange = vi.fn();
    setWindow.mockResolvedValueOnce({});
    const user = userEvent.setup();
    renderDialog({ onOpenChange });
    const startInput = screen.getByLabelText(/start position/i);
    const endInput = screen.getByLabelText(/end position/i);
    await user.clear(startInput);
    await user.type(startInput, '-1e4');
    await user.clear(endInput);
    await user.type(endInput, '2.6e4');
    const saveBtn = screen.getByRole('button', { name: /^save range$/i });
    await user.click(saveBtn);
    expect(setWindow).toHaveBeenCalledWith({ start: -10000, end: 26000 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows inline error "Couldn\'t save range. Try again." on mutation rejection and leaves dialog open', async () => {
    const onOpenChange = vi.fn();
    setWindow.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    renderDialog({ onOpenChange });
    const startInput = screen.getByLabelText(/start position/i);
    const endInput = screen.getByLabelText(/end position/i);
    await user.clear(startInput);
    await user.type(startInput, '0');
    await user.clear(endInput);
    await user.type(endInput, '100');
    const saveBtn = screen.getByRole('button', { name: /^save range$/i });
    await user.click(saveBtn);
    expect(
      await screen.findByText("Couldn't save range. Try again."),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('renders Cancel button with exact text "Keep current range"', () => {
    renderDialog();
    expect(
      screen.getByRole('button', { name: /^keep current range$/i }),
    ).toBeInTheDocument();
  });

  it('renders Save button with exact text "Save range"', () => {
    renderDialog();
    expect(
      screen.getByRole('button', { name: /^save range$/i }),
    ).toBeInTheDocument();
  });
});
