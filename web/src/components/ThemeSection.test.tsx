import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeSection } from './ThemeSection';
import type { Universe } from '../hooks/useUniverse';

const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock('../hooks/useUniverse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useUniverse')>();
  return {
    ...actual,
    useUpdateUniverse: () => ({ mutateAsync, isPending: false }),
  };
});
vi.mock('./AssetPickerModal', () => ({
  AssetPickerModal: ({ open, onSelect }: { open: boolean; onSelect: (id: string) => void }) =>
    open ? (
      <button onClick={() => onSelect('asset-123')}>pick-mock-asset</button>
    ) : null,
}));

const universe = {
  id: 'u1',
  name: 'Ayins Edge',
  theme: null,
  backdropUrl: null,
  backdropThumbUrl: null,
} as unknown as Universe;

beforeEach(() => mutateAsync.mockClear());

describe('ThemeSection', () => {
  it('renders all five palette options and four fonts', () => {
    render(<ThemeSection universe={universe} />);
    for (const p of ['Observatory', 'Ember', 'Verdant', 'Abyssal', 'Parchment']) {
      expect(screen.getByRole('button', { name: new RegExp(p, 'i') })).toBeInTheDocument();
    }
    for (const f of ['Spectral', 'Cormorant', 'Cinzel', 'Crimson']) {
      expect(screen.getByLabelText(new RegExp(f, 'i'))).toBeInTheDocument();
    }
  });

  it('saves the selected palette and font as a complete theme object', async () => {
    render(<ThemeSection universe={universe} />);
    await userEvent.click(screen.getByRole('button', { name: /ember/i }));
    await userEvent.click(screen.getByLabelText(/cinzel/i));
    await userEvent.click(screen.getByRole('button', { name: /save theme/i }));
    expect(mutateAsync).toHaveBeenCalledWith({
      theme: { palette: 'ember', displayFont: 'cinzel' },
    });
  });

  it('picks a backdrop via the asset picker and includes it on save', async () => {
    render(<ThemeSection universe={universe} />);
    await userEvent.click(screen.getByRole('button', { name: /choose image/i }));
    await userEvent.click(screen.getByRole('button', { name: 'pick-mock-asset' }));
    await userEvent.click(screen.getByRole('button', { name: /save theme/i }));
    expect(mutateAsync).toHaveBeenCalledWith({
      theme: { backdropAssetId: 'asset-123' },
    });
  });

  it('Save is disabled until the draft differs from the saved theme', async () => {
    render(<ThemeSection universe={universe} />);
    const saveBtn = screen.getByRole('button', { name: /save theme/i });
    expect(saveBtn).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /ember/i }));
    expect(saveBtn).not.toBeDisabled();
  });

  it('reset sends theme: null', async () => {
    render(
      <ThemeSection universe={{ ...universe, theme: { palette: 'ember' } } as Universe} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(mutateAsync).toHaveBeenCalledWith({ theme: null });
  });
});
