import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { RelationCombobox } from './RelationCombobox';

function Harness({
  universeId = 'U1',
  initial = '',
}: { universeId?: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <RelationCombobox
      universeId={universeId}
      value={value}
      onChange={setValue}
      placeholder='e.g. "created by"'
    />
  );
}

function renderHarness(props?: { universeId?: string; initial?: string }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Harness {...props} />
    </QueryClientProvider>
  );
}

describe('RelationCombobox', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it('renders a controlled input with role=combobox and the placeholder', () => {
    vi.mocked(api).mockResolvedValue([]);
    renderHarness();
    const input = screen.getByRole('combobox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', 'e.g. "created by"');
  });

  it('opens the popover on focus and lists suggestions with their counts', async () => {
    vi.mocked(api).mockResolvedValue([
      { label: 'created by', count: 17 },
      { label: 'allies of', count: 9 },
    ]);
    const user = userEvent.setup();
    renderHarness();

    const input = screen.getByRole('combobox');
    await user.click(input);

    expect(await screen.findByText('created by')).toBeInTheDocument();
    expect(screen.getByText('17')).toBeInTheDocument();
    expect(screen.getByText('allies of')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
  });

  it('filters suggestions by case-insensitive substring match on input', async () => {
    vi.mocked(api).mockResolvedValue([
      { label: 'created by', count: 17 },
      { label: 'allies of', count: 9 },
    ]);
    const user = userEvent.setup();
    renderHarness();

    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.type(input, 'cre');

    await waitFor(() => {
      expect(screen.getByText('created by')).toBeInTheDocument();
    });
    expect(screen.queryByText('allies of')).toBeNull();
  });

  it('clicking a suggestion sets the value to the suggestion label', async () => {
    vi.mocked(api).mockResolvedValue([
      { label: 'created by', count: 17 },
    ]);
    const user = userEvent.setup();
    renderHarness();

    const input = screen.getByRole('combobox') as HTMLInputElement;
    await user.click(input);
    const suggestion = await screen.findByText('created by');
    await user.click(suggestion);

    expect(input.value).toBe('created by');
  });

  it('pressing Enter on a non-matching typed value keeps the typed string and closes the popover', async () => {
    vi.mocked(api).mockResolvedValue([
      { label: 'created by', count: 17 },
    ]);
    const user = userEvent.setup();
    renderHarness();

    const input = screen.getByRole('combobox') as HTMLInputElement;
    await user.click(input);
    await user.type(input, 'invented label');
    expect(input).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Enter}');

    expect(input.value).toBe('invented label');
    await waitFor(() => {
      expect(input).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('shows an empty-state hint when no relations match the typed value', async () => {
    vi.mocked(api).mockResolvedValue([]);
    const user = userEvent.setup();
    renderHarness();

    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.type(input, 'xyz');

    expect(
      await screen.findByText(/no matches/i)
    ).toBeInTheDocument();
  });
});
