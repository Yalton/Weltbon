import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';

function baseProps(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Delete "Yondergrove"?',
    body: 'This permanently removes the universe and everything inside it. This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true as const,
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe('ConfirmDialog — backward compatibility (no confirmPhrase)', () => {
  it('Test 1: renders without an input and with an enabled Delete button when confirmPhrase is omitted', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...baseProps({ onConfirm })} />);

    expect(
      screen.queryByRole('textbox', { name: /type universe name to confirm deletion/i })
    ).toBeNull();

    const deleteBtn = screen.getByRole('button', { name: /^delete$/i });
    expect(deleteBtn).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(deleteBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Test 2: confirmPhrase="" behaves identically to omitted (no input, Delete enabled)', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...baseProps({ onConfirm })} confirmPhrase="" />);

    expect(
      screen.queryByRole('textbox', { name: /type universe name to confirm deletion/i })
    ).toBeNull();

    const deleteBtn = screen.getByRole('button', { name: /^delete$/i });
    expect(deleteBtn).not.toBeDisabled();

    const user = userEvent.setup();
    await user.click(deleteBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('ConfirmDialog — typed-confirmation gate (confirmPhrase set)', () => {
  it('Test 3: renders input + helper label with font-mono phrase and disables Delete on initial render', () => {
    render(<ConfirmDialog {...baseProps()} confirmPhrase="Yondergrove" />);

    const input = screen.getByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    expect(input).toBeInTheDocument();

    // Helper label text
    expect(screen.getByText(/type/i)).toBeInTheDocument();
    expect(screen.getByText('Yondergrove')).toBeInTheDocument();
    expect(screen.getByText(/to confirm\./i)).toBeInTheDocument();

    // The phrase span must carry font-mono
    const phraseSpan = screen.getByText('Yondergrove');
    expect(phraseSpan.className).toMatch(/font-mono/);

    // Delete starts disabled
    const deleteBtn = screen.getByRole('button', { name: /^delete$/i });
    expect(deleteBtn).toBeDisabled();
  });

  it('Test 4: typing the exact phrase enables Delete; clicking it fires onConfirm once', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDialog {...baseProps({ onConfirm })} confirmPhrase="Yondergrove" />);

    const input = screen.getByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    const deleteBtn = screen.getByRole('button', { name: /^delete$/i });

    await user.type(input, 'Yondergrove');
    expect(deleteBtn).not.toBeDisabled();

    await user.click(deleteBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Test 5: case-sensitive trimmed match — wrong case stays disabled; whitespace-padded matches; internal-whitespace mismatch stays disabled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConfirmDialog {...baseProps()} confirmPhrase="Yondergrove" />
    );

    const input = screen.getByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    const deleteBtn = screen.getByRole('button', { name: /^delete$/i });

    // Wrong case: still disabled
    await user.type(input, 'yondergrove');
    expect(deleteBtn).toBeDisabled();

    // Clear and type with surrounding whitespace: enabled (trim allowed)
    await user.clear(input);
    await user.type(input, '  Yondergrove  ');
    expect(deleteBtn).not.toBeDisabled();

    // Force rerender to clear typed state via close/reopen
    rerender(
      <ConfirmDialog
        {...baseProps({ open: false })}
        confirmPhrase="Yondergrove"
      />
    );
    rerender(<ConfirmDialog {...baseProps()} confirmPhrase="Yondergrove" />);

    const input2 = screen.getByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });
    const deleteBtn2 = screen.getByRole('button', { name: /^delete$/i });

    // Internal whitespace mismatch: still disabled
    await user.type(input2, 'Yonder grove');
    expect(deleteBtn2).toBeDisabled();
  });

  it('Test 6: Enter inside the input confirms only when matched', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDialog {...baseProps({ onConfirm })} confirmPhrase="Yondergrove" />);

    const input = screen.getByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    });

    // Partial: Enter does NOT call onConfirm
    await user.type(input, 'Yonder');
    await user.keyboard('{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();

    // Complete the match
    await user.type(input, 'grove');
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Test 7: state resets to empty when the dialog closes and reopens', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ConfirmDialog {...baseProps()} confirmPhrase="Yondergrove" />
    );

    const input = screen.getByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    }) as HTMLInputElement;
    await user.type(input, 'Yonder');
    expect(input.value).toBe('Yonder');

    // Close
    rerender(
      <ConfirmDialog {...baseProps({ open: false })} confirmPhrase="Yondergrove" />
    );

    // Reopen
    rerender(<ConfirmDialog {...baseProps()} confirmPhrase="Yondergrove" />);
    const reopenedInput = screen.getByRole('textbox', {
      name: /type universe name to confirm deletion/i,
    }) as HTMLInputElement;
    expect(reopenedInput.value).toBe('');
  });

  it('Test 8: disabled Delete carries the "Type the universe name above to enable Delete" title attribute', async () => {
    render(<ConfirmDialog {...baseProps()} confirmPhrase="Yondergrove" />);

    const deleteBtn = screen.getByRole('button', { name: /^delete$/i });
    expect(deleteBtn).toBeDisabled();
    expect(deleteBtn.getAttribute('title')).toBe(
      'Type the universe name above to enable Delete'
    );
  });
});
