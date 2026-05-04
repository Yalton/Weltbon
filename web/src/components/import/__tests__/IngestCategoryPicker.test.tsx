import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../../hooks/useCategories', () => ({
  useCategories: vi.fn(() => ({
    data: {
      categories: [
        { id: 'cat-1', label: 'Heroes', icon: '🦸', sortOrder: 0, entryCount: 0 },
        { id: 'cat-2', label: 'Lore', icon: '', sortOrder: 1, entryCount: 0 },
      ],
      uncategorizedCount: 0,
    },
    isLoading: false,
  })),
}));

import { IngestCategoryPicker } from '../IngestCategoryPicker';

function renderPicker(
  props: Partial<React.ComponentProps<typeof IngestCategoryPicker>> = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onChange = vi.fn();
  const merged: React.ComponentProps<typeof IngestCategoryPicker> = {
    universeId: 'U1',
    value: null,
    onChange,
    ...props,
  };
  const utils = render(
    <QueryClientProvider client={qc}>
      <IngestCategoryPicker {...merged} />
    </QueryClientProvider>,
  );
  return { ...utils, onChange };
}

describe('IngestCategoryPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Uncategorized as the first option when value is null', () => {
    renderPicker({ value: null });
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('');
    const firstOption = select.options[0];
    expect(firstOption.textContent).toMatch(/uncategorized/i);
  });

  it('shows the existing category label as selected when value is { existingId }', () => {
    renderPicker({ value: { existingId: 'cat-1' } });
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('cat-1');
  });

  it('renders the "+ Create category" option in the select dropdown', () => {
    renderPicker({ value: null });
    expect(screen.getByRole('option', { name: /\+ Create category/i })).toBeInTheDocument();
  });

  it('selecting "+ Create category" swaps to autoFocus input + "Will be created" helper', async () => {
    const user = userEvent.setup();
    renderPicker({ value: null });
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, '__new__');

    const input = screen.getByPlaceholderText(/new category name/i) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // jsdom autoFocus → activeElement is the input
    expect(document.activeElement).toBe(input);
    expect(screen.getByText(/will be created/i)).toBeInTheDocument();
  });

  it('typing a name + blur calls onChange with { newName }', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: null });
    await user.selectOptions(screen.getByRole('combobox'), '__new__');
    const input = screen.getByPlaceholderText(/new category name/i);
    await user.type(input, 'Lore');
    await user.tab(); // triggers blur
    expect(onChange).toHaveBeenCalledWith({ newName: 'Lore' });
  });

  it('typing a name + Enter calls onChange with { newName }', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: null });
    await user.selectOptions(screen.getByRole('combobox'), '__new__');
    const input = screen.getByPlaceholderText(/new category name/i);
    await user.type(input, 'Lore{Enter}');
    expect(onChange).toHaveBeenCalledWith({ newName: 'Lore' });
  });

  it('Escape from create-mode swaps back to select and onChange called with null', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: null });
    await user.selectOptions(screen.getByRole('combobox'), '__new__');
    const input = screen.getByPlaceholderText(/new category name/i);
    await user.type(input, 'Loremaster');
    await user.keyboard('{Escape}');
    expect(onChange).toHaveBeenCalledWith(null);
    // input gone, select restored
    expect(screen.queryByPlaceholderText(/new category name/i)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('empty newNameDraft + blur treats as cancel (onChange null, mode back to select)', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: null });
    await user.selectOptions(screen.getByRole('combobox'), '__new__');
    const input = screen.getByPlaceholderText(/new category name/i);
    // do not type anything, blur immediately
    input.focus();
    await user.tab();
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.queryByPlaceholderText(/new category name/i)).not.toBeInTheDocument();
  });

  it('initial value { newName } starts in create mode with input pre-filled and helper visible', () => {
    renderPicker({ value: { newName: 'Pending' } });
    const input = screen.getByPlaceholderText(/new category name/i) as HTMLInputElement;
    expect(input.value).toBe('Pending');
    expect(screen.getByText(/will be created/i)).toBeInTheDocument();
  });

  it('selecting Uncategorized (empty value) calls onChange with null', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: { existingId: 'cat-1' } });
    await user.selectOptions(screen.getByRole('combobox'), '');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('selecting an existing category calls onChange with { existingId }', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ value: null });
    await user.selectOptions(screen.getByRole('combobox'), 'cat-2');
    expect(onChange).toHaveBeenCalledWith({ existingId: 'cat-2' });
  });
});
