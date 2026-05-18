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

  it('shows inline error "Enter a valid number ..." when submitting empty inputs', async () => {
    const user = userEvent.setup();
    renderDialog();
    const saveBtn = screen.getByRole('button', { name: /^save range$/i });
    await user.click(saveBtn);
    expect(
      screen.getByText('Enter a valid number (e.g. 4.35e17 or -10000).'),
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
