import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/client', () => ({
  api: vi.fn(),
}));
import { api } from '../api/client';
import { CategoryManageDialog } from './CategoryManageDialog';

function renderDialog(props: Parameters<typeof CategoryManageDialog>[0]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CategoryManageDialog {...props} />
    </QueryClientProvider>,
  );
}

describe('CategoryManageDialog', () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it('renders in create mode with empty fields and calls POST on save', async () => {
    vi.mocked(api).mockResolvedValue({ id: 'c1', label: 'People', icon: '👤', sortOrder: 0, entryCount: 0 });
    const onOpenChange = vi.fn();

    renderDialog({ universeId: 'U1', open: true, onOpenChange, initialCategory: null });

    const labelInput = await screen.findByLabelText(/label/i);
    const iconInput = screen.getByLabelText(/icon/i);

    await userEvent.type(labelInput, 'People');
    await userEvent.type(iconInput, '👤');

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(api).toHaveBeenCalledWith(
      '/universes/U1/categories',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ label: 'People', icon: '👤' }),
      }),
    );
  });

  it('renders in edit mode pre-filled and calls PATCH on save', async () => {
    vi.mocked(api).mockResolvedValue({ id: 'c1', label: 'Nobles', icon: '👑', sortOrder: 0, entryCount: 0 });
    const onOpenChange = vi.fn();

    renderDialog({
      universeId: 'U1',
      open: true,
      onOpenChange,
      initialCategory: { id: 'c1', label: 'People', icon: '👤', sortOrder: 0, entryCount: 5 },
    });

    const labelInput = (await screen.findByLabelText(/label/i)) as HTMLInputElement;
    expect(labelInput.value).toBe('People');

    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'Nobles');

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(api).toHaveBeenCalledWith(
      '/universes/U1/categories/c1',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"label":"Nobles"'),
      }),
    );
  });

  it('does not submit when label is empty', async () => {
    const onOpenChange = vi.fn();

    renderDialog({ universeId: 'U1', open: true, onOpenChange, initialCategory: null });

    await screen.findByLabelText(/label/i);
    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).toBeDisabled();

    expect(api).not.toHaveBeenCalled();
  });
});
